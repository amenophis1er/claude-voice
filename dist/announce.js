import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
/**
 * Project announcement. With several Claude Code sessions running at once, a
 * bare "Task complete" doesn't say WHICH project finished — so spoken text can
 * be prefixed with the working directory's name ("claude voice: Task
 * complete."). The `announceProject` config field controls it: "always",
 * "off", or "auto" — prefix only while at least one OTHER session is active,
 * tracked by a per-session heartbeat file that every hook event refreshes.
 */
/** A session counts as active if one of its hooks fired within this window. */
const ACTIVE_WINDOW_MS = 30 * 60 * 1000;
/** Heartbeats older than this are leftovers from crashed sessions — reap them. */
const STALE_MS = 24 * 60 * 60 * 1000;
/** Overridable so tests never see (or disturb) the developer's real sessions. */
function sessionsDir() {
    return process.env.CLAUDE_VOICE_SESSIONS_DIR ?? join(tmpdir(), "claude-voice-sessions");
}
/** Speakable project name from the hook's cwd: "my-app.v2" → "my app v2". */
export function projectName(cwd) {
    if (typeof cwd !== "string")
        return undefined;
    const name = basename(cwd.trim()).replace(/[-_.]+/g, " ").replace(/\s+/g, " ").trim();
    return name || undefined;
}
/** Clamp/sanitize the message FIRST, then prepend — the name never gets cut. */
export function withProjectPrefix(text, name) {
    return name ? `${name}: ${text}` : text;
}
export function shouldAnnounceProject(cfg, session) {
    if (cfg.announceProject === "always")
        return true;
    if (cfg.announceProject === "off")
        return false;
    return otherSessionsActive(session); // "auto"
}
/** Refresh this session's heartbeat (every hook event lands here). */
export function touchSession(session) {
    try {
        mkdirSync(sessionsDir(), { recursive: true });
        writeFileSync(join(sessionsDir(), fileFor(session)), "");
    }
    catch {
        /* best effort */
    }
}
/** Forget a session (SessionEnd hook). */
export function endSession(session) {
    try {
        unlinkSync(join(sessionsDir(), fileFor(session)));
    }
    catch {
        /* already gone */
    }
}
/** True when another session's heartbeat is fresher than the active window. */
function otherSessionsActive(session) {
    const dir = sessionsDir();
    const mine = fileFor(session);
    try {
        for (const f of readdirSync(dir)) {
            let mtime;
            try {
                mtime = statSync(join(dir, f)).mtimeMs;
            }
            catch {
                continue;
            }
            if (now() - mtime > STALE_MS) {
                try {
                    unlinkSync(join(dir, f));
                }
                catch {
                    /* skip */
                }
                continue;
            }
            if (f !== mine && now() - mtime <= ACTIVE_WINDOW_MS)
                return true;
        }
    }
    catch {
        /* no registry yet → no other sessions */
    }
    return false;
}
/** Session ids are uuids today; sanitize anyway so any id is filename-safe. */
function fileFor(session) {
    return session.replace(/[^\w.-]/g, "_");
}
function now() {
    return Date.now();
}
