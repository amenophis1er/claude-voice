import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clampSpokenLength, sanitizeForSpeech } from "./sanitize.ts";

/**
 * Milestones (verbose preset): mid-task, Claude narrates what it's doing in
 * short visible remarks between tool calls — "Now turning both old copies into
 * pointer stubs." Speaking the most recent remark at a gentle pace lets you
 * follow a long task from across the room. The taste rules live in dispatch
 * (deep turns only, nothing while audio plays); this module owns the per-
 * session pacing state: minimum interval and don't-repeat-yourself.
 */

/** Milestones are glances, not summaries — keep them shorter than a stop's. */
const MAX_MILESTONE_CHARS = 200;

const stateFile = (s: string) => join(tmpdir(), `claude-voice-${s}.milestone`);

/**
 * The milestone to speak now, or undefined (too soon / same as last / nothing
 * speakable). Recording happens on return, so a caller that gets text back is
 * committed to speaking it.
 */
export function nextMilestone(
  session: string,
  text: string,
  intervalSeconds: number,
  now = Date.now(),
): string | undefined {
  const clean = clampSpokenLength(sanitizeForSpeech(text), MAX_MILESTONE_CHARS);
  if (!clean) return undefined;

  let lastTs = 0;
  let lastText = "";
  try {
    const [ts, ...rest] = readFileSync(stateFile(session), "utf8").split("\n");
    lastTs = Number(ts) || 0;
    lastText = rest.join("\n");
  } catch {
    /* first milestone of the session */
  }
  if (now - lastTs < intervalSeconds * 1000) return undefined;
  if (clean === lastText) return undefined;

  try {
    writeFileSync(stateFile(session), `${now}\n${clean}`);
  } catch {
    return undefined; // can't record → don't risk repeating it forever
  }
  return clean;
}

/** Reset pacing state at turn boundaries (prompt submit), so a new task can
 * milestone right away and an old remark never blocks its own re-mention. */
export function clearMilestone(session: string): void {
  try {
    unlinkSync(stateFile(session));
  } catch {
    /* nothing recorded */
  }
}
