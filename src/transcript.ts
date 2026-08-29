import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";

interface TurnStats {
  lastAssistantText: string;
  /** Epoch ms of the entry carrying lastAssistantText — freshness gate for milestones. */
  lastAssistantTs?: number;
  toolCalls: number;
  durationSeconds: number;
}

/** Transcripts grow unbounded; reading one synchronously on every hook event
 * costs the hook budget. Beyond this, skip the heuristic entirely — the
 * spoken text itself comes from last_assistant_message and is unaffected. */
const MAX_TRANSCRIPT_BYTES = 20 * 1024 * 1024;

/**
 * Best-effort read of the just-finished turn from a Claude Code transcript
 * (JSONL), used ONLY for the "was this substantial?" heuristic (tool count +
 * duration). The transcript's raw schema is internal to Claude Code and can
 * change between versions, so every caller must tolerate `undefined` and never
 * depend on this for correctness — the spoken text itself comes from the stable
 * `last_assistant_message` hook field, not from here.
 */
export function readLastTurn(transcriptPath: string, now = Date.now()): TurnStats | undefined {
  const entries = readEntries(transcriptPath);
  if (!entries) return undefined;
  // Find the boundary of the current turn: everything after the last HUMAN
  // message. Tool results also arrive as type:"user" entries in the transcript,
  // so a plain type check would clip the turn to the tail after the last tool
  // call and undercount everything.
  let start = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isHumanPrompt(entries[i])) {
      start = i + 1;
      break;
    }
  }
  const turn = entries.slice(start);

  let lastAssistantText = "";
  let lastAssistantTs: number | undefined;
  let toolCalls = 0;
  const stamps: number[] = [];
  for (const e of turn) {
    const t = Date.parse(e?.timestamp ?? "");
    if (!Number.isNaN(t)) stamps.push(t);
    const content = e?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "tool_use") toolCalls++;
      if (block?.type === "text" && e?.type === "assistant" && block.text) {
        lastAssistantText = block.text;
        if (!Number.isNaN(t)) lastAssistantTs = t;
      }
    }
  }

  // Measured to NOW, not to the last entry: hooks fire while the turn is
  // still live (PreToolUse arrives before a possibly-minutes-long tool runs),
  // and the question is "how long has this turn been going", not "how much
  // span do the recorded entries cover".
  const durationSeconds = stamps.length ? (now - Math.min(...stamps)) / 1000 : 0;

  return { lastAssistantText, lastAssistantTs, toolCalls, durationSeconds };
}

/**
 * Are background tasks (agents, backgrounded Bash commands, forked skills)
 * still pending in this session? Drives the idle-nudge suppression: while
 * something runs in the background, "Claude is waiting for you" is false —
 * Claude resumes on its own when the task lands, nothing is user-actionable.
 *
 * Launches carry a durable id in toolUseResult (`agentId` when
 * `background: true`, or `backgroundTaskId` for Bash); each completion arrives
 * as a task-notification entry naming that id. Pending = launched − notified,
 * scoped to the CURRENT turn: earlier turns' background work either resolved
 * or never will (killed tasks, dev servers) — counting those would mute the
 * idle nudge for the rest of the session.
 * Same schema caveat as readLastTurn: best-effort, callers tolerate undefined.
 */
export function pendingBackgroundTasks(transcriptPath: string): number | undefined {
  // Long agent-heavy sessions — the very ones with background tasks — blow
  // past MAX_TRANSCRIPT_BYTES, so read a bounded tail instead of bailing.
  // idle_prompt is rare, and the current turn lives at the end of the file.
  // A turn longer than the window loses its oldest launches → pending
  // undercounts → the nudge speaks as it always did; never worse than before.
  const entries = readTailEntries(transcriptPath, 8 * 1024 * 1024);
  if (!entries) return undefined;

  let start = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isHumanPrompt(entries[i])) {
      start = i + 1;
      break;
    }
  }

  const launched = new Set<string>();
  const resolved = new Set<string>();
  for (const e of entries.slice(start)) {
    const r = e?.toolUseResult;
    if (typeof r?.backgroundTaskId === "string") launched.add(r.backgroundTaskId);
    else if (r?.background === true && typeof r?.agentId === "string") launched.add(r.agentId);
    const c = e?.message?.content;
    if (isTaskNotification(e) && typeof c === "string") {
      const id = c.match(/<task-id>([^<]+)<\/task-id>/)?.[1];
      if (id) resolved.add(id);
    }
  }

  let pending = 0;
  for (const id of launched) if (!resolved.has(id)) pending++;
  return pending;
}

function readEntries(transcriptPath: string): any[] | undefined {
  try {
    if (statSync(transcriptPath).size > MAX_TRANSCRIPT_BYTES) return undefined;
    return parseLines(readFileSync(transcriptPath, "utf8"));
  } catch {
    return undefined;
  }
}

/** Read at most the last `maxBytes` of the file, dropping the leading partial line. */
function readTailEntries(transcriptPath: string, maxBytes: number): any[] | undefined {
  try {
    const size = statSync(transcriptPath).size;
    if (size <= maxBytes) return parseLines(readFileSync(transcriptPath, "utf8"));
    const fd = openSync(transcriptPath, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      const n = readSync(fd, buf, 0, maxBytes, size - maxBytes);
      const text = buf.toString("utf8", 0, n);
      return parseLines(text.slice(text.indexOf("\n") + 1));
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

function parseLines(text: string): any[] {
  return text.split("\n").filter(Boolean).map(safeParse).filter(Boolean) as any[];
}

/** A type:"user" entry typed by the human, as opposed to a wrapped tool_result. */
function isHumanPrompt(e: any): boolean {
  if (e?.type !== "user") return false;
  // Background-task completions are injected as user entries with string
  // content — indistinguishable from a typed prompt by shape alone. They
  // CONTINUE the turn (Claude resumes on them), so treating them as a turn
  // boundary would clip the stats and make a long agent-driven turn look
  // trivial enough to skip its spoken summary.
  if (isTaskNotification(e)) return false;
  const c = e?.message?.content;
  if (typeof c === "string") return true;
  if (!Array.isArray(c)) return false;
  return (
    c.some((b: any) => b?.type === "text") && !c.some((b: any) => b?.type === "tool_result")
  );
}

function isTaskNotification(e: any): boolean {
  return e?.origin?.kind === "task-notification" || e?.promptSource === "system";
}

function safeParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
