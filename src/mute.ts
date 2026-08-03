import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Purposeful, global mute — "shut up until I say otherwise / for 2 hours".
 * Complements the automatic silencers (quiet hours, focus muting): this one is
 * an explicit user action, via `claude-voice mute [duration]` or /voice mute.
 * Global across sessions on purpose: "mute" means the room goes quiet.
 */
export const MUTE_PATH = join(homedir(), ".claude", "voice", "mute.json");

/** "30m" | "2h" | "1d" → milliseconds; undefined input → null (indefinite). */
export function parseDurationMs(s?: string): number | null {
  if (!s) return null;
  const m = /^(\d+)([mhd])$/.exec(s.trim());
  if (!m) throw new Error(`bad duration "${s}" — use e.g. 30m, 2h, 1d`);
  const n = Number(m[1]);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
  return n * unit;
}

/** Is a purposeful mute currently active? Expired mutes are cleaned up. */
export function muted(now = Date.now()): boolean {
  let until: unknown;
  try {
    ({ until } = JSON.parse(readFileSync(MUTE_PATH, "utf8")));
  } catch {
    return false; // no mute file → not muted
  }
  if (until === null) return true; // indefinite
  if (typeof until === "number") {
    if (now < until) return true;
    try {
      unlinkSync(MUTE_PATH); // expired → clean up
    } catch {
      /* best effort */
    }
  }
  return false;
}

/** Activate a mute. Returns a human description for the CLI to print. */
export function mute(duration?: string, now = Date.now()): string {
  const ms = parseDurationMs(duration);
  const until = ms === null ? null : now + ms;
  writeFileSync(MUTE_PATH, JSON.stringify({ until }) + "\n");
  return until === null
    ? "Muted until you run unmute."
    : `Muted for ${duration} (until ${new Date(until).toLocaleTimeString()}).`;
}

export function unmute(): string {
  try {
    unlinkSync(MUTE_PATH);
    return "Unmuted.";
  } catch {
    return "Was not muted.";
  }
}

/** One-line state for `claude-voice status` / the /voice command. */
export function muteStatus(now = Date.now()): string {
  try {
    const { until } = JSON.parse(readFileSync(MUTE_PATH, "utf8"));
    if (until === null) return "muted (indefinitely)";
    if (typeof until === "number" && now < until)
      return `muted until ${new Date(until).toLocaleTimeString()}`;
  } catch {
    /* fall through */
  }
  return "not muted";
}
