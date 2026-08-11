import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { VoiceConfig } from "./config.ts";
import { sessionTabFocused, sessionTabInfo } from "./tab.ts";

/**
 * Project announcement. With several Claude Code sessions running at once, a
 * bare "Task complete" doesn't say WHICH project finished — so spoken text can
 * be prefixed with the working directory's name ("claude voice: Task
 * complete."). The `announceProject` config field controls it: "always",
 * "off", or "auto" — prefix only while at least one OTHER session is active,
 * tracked by a per-session heartbeat file that every hook event refreshes.
 *
 * "auto" gets one refinement on macOS: if the user is looking straight at THIS
 * session's tab right now (its terminal is frontmost AND its tab is selected),
 * the prefix is noise — skip it. Detection lives in tab.ts and fails open
 * (prefix) whenever it can't tell: no Automation permission, non-scriptable
 * terminal, tmux, ssh, Linux.
 */

/** A session counts as active if one of its hooks fired within this window. */
const ACTIVE_WINDOW_MS = 30 * 60 * 1000;
/** Heartbeats older than this are leftovers from crashed sessions — reap them. */
const STALE_MS = 24 * 60 * 60 * 1000;

/** Overridable so tests never see (or disturb) the developer's real sessions. */
function sessionsDir(): string {
  return process.env.CLAUDE_VOICE_SESSIONS_DIR ?? join(tmpdir(), "claude-voice-sessions");
}

/** Speakable project name from the hook's cwd: "my-app.v2" → "my app v2". */
export function projectName(cwd: unknown): string | undefined {
  if (typeof cwd !== "string") return undefined;
  const name = basename(cwd.trim()).replace(/[-_.]+/g, " ").replace(/\s+/g, " ").trim();
  return name || undefined;
}

/** Clamp/sanitize the message FIRST, then prepend — the name never gets cut. */
export function withProjectPrefix(text: string, name: string | undefined): string {
  return name ? `${name}: ${text}` : text;
}

export function shouldAnnounceProject(
  cfg: VoiceConfig,
  session: string,
  ownTabFocused?: () => boolean | undefined, // test seam; default: tab.ts
): boolean {
  if (cfg.announceProject === "always") return true;
  if (cfg.announceProject === "off") return false;
  // "auto": prefix only while another session is live — AND not while the
  // user is looking straight at this session's own tab (you already know).
  if (!otherSessionsActive(session)) return false;
  return !ownTabInFocus(session, ownTabFocused);
}

/** True when this session's terminal tab is the selected one in the frontmost
 * window — you are looking at it, so the project-name prefix adds nothing.
 * Fail open: any uncertainty (no tty, no scriptable terminal, no permission)
 * returns false — the prefix is never wrongly suppressed. Injectable for tests;
 * the default resolves via tab.ts. */
export function ownTabInFocus(
  session: string,
  detector: () => boolean | undefined = defaultIsFocused,
): boolean {
  try {
    return detector() === true;
  } catch {
    return false; // detection must never throw — prefix is safe
  }
}

function defaultIsFocused(): boolean | undefined {
  const info = sessionTabInfo(process.pid);
  return info ? sessionTabFocused(info) : undefined;
}

/** Refresh this session's heartbeat (every hook event lands here). */
export function touchSession(session: string): void {
  try {
    mkdirSync(sessionsDir(), { recursive: true });
    writeFileSync(join(sessionsDir(), fileFor(session)), "");
  } catch {
    /* best effort */
  }
}

/** Forget a session (SessionEnd hook). */
export function endSession(session: string): void {
  try {
    unlinkSync(join(sessionsDir(), fileFor(session)));
  } catch {
    /* already gone */
  }
}

/** True when another session's heartbeat is fresher than the active window. */
function otherSessionsActive(session: string): boolean {
  const dir = sessionsDir();
  const mine = fileFor(session);
  try {
    for (const f of readdirSync(dir)) {
      let mtime: number;
      try {
        mtime = statSync(join(dir, f)).mtimeMs;
      } catch {
        continue;
      }
      if (now() - mtime > STALE_MS) {
        try {
          unlinkSync(join(dir, f));
        } catch {
          /* skip */
        }
        continue;
      }
      if (f !== mine && now() - mtime <= ACTIVE_WINDOW_MS) return true;
    }
  } catch {
    /* no registry yet → no other sessions */
  }
  return false;
}

/** Session ids are uuids today; sanitize anyway so any id is filename-safe. */
function fileFor(session: string): string {
  return session.replace(/[^\w.-]/g, "_");
}

function now(): number {
  return Date.now();
}
