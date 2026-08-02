import { readFileSync } from "node:fs";

interface TurnStats {
  lastAssistantText: string;
  toolCalls: number;
  durationSeconds: number;
}

/**
 * Best-effort read of the just-finished turn from a Claude Code transcript
 * (JSONL), used ONLY for the "was this substantial?" heuristic (tool count +
 * duration). The transcript's raw schema is internal to Claude Code and can
 * change between versions, so every caller must tolerate `undefined` and never
 * depend on this for correctness — the spoken text itself comes from the stable
 * `last_assistant_message` hook field, not from here.
 */
export function readLastTurn(transcriptPath: string): TurnStats | undefined {
  let lines: string[];
  try {
    lines = readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean);
  } catch {
    return undefined;
  }

  const entries = lines.map(safeParse).filter(Boolean) as any[];
  // Find the boundary of the current turn: everything after the last user msg.
  let start = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.type === "user") {
      start = i + 1;
      break;
    }
  }
  const turn = entries.slice(start);

  let lastAssistantText = "";
  let toolCalls = 0;
  const stamps: number[] = [];
  for (const e of turn) {
    const t = Date.parse(e?.timestamp ?? "");
    if (!Number.isNaN(t)) stamps.push(t);
    const content = e?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "tool_use") toolCalls++;
      if (block?.type === "text" && e?.type === "assistant") {
        lastAssistantText = block.text ?? lastAssistantText;
      }
    }
  }

  const durationSeconds =
    stamps.length >= 2 ? (Math.max(...stamps) - Math.min(...stamps)) / 1000 : 0;

  return { lastAssistantText, toolCalls, durationSeconds };
}

function safeParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
