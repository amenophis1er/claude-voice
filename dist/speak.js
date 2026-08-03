import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, } from "node:fs";
import { platform, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { defaultProvider, getProvider } from "./providers/registry.js";
const HERE = dirname(fileURLToPath(import.meta.url));
/** ".ts" when running straight from source (Node 23.6+), ".js" from dist/. */
const EXT = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
const AUDIO_DIR = join(tmpdir(), "claude-voice-audio");
mkdirSync(AUDIO_DIR, { recursive: true });
/** State files are keyed by session so parallel Claude sessions don't collide. */
const pidFile = (s) => join(tmpdir(), `claude-voice-${s}.pid`);
const throttleFile = (s) => join(tmpdir(), `claude-voice-${s}.last`);
export function logDebug(msg) {
    if (!process.env.CLAUDE_VOICE_DEBUG)
        return;
    try {
        appendFileSync(join(tmpdir(), "claude-voice-debug.log"), `${isoNow()} ${msg}\n`);
    }
    catch {
        /* logging must never throw */
    }
}
// ── Throttle (session-scoped) ────────────────────────────────────────────────
export function throttled(session, seconds) {
    try {
        return now() - Number(readFileSync(throttleFile(session), "utf8")) < seconds * 1000;
    }
    catch {
        return false;
    }
}
export function markSpoken(session) {
    try {
        writeFileSync(throttleFile(session), String(now()));
    }
    catch {
        /* best effort */
    }
}
// ── Non-blocking entry points (used by dispatch) ─────────────────────────────
// Spawn a detached worker that synthesizes + plays, then return immediately so
// the hook exits fast and never stalls the session.
export function detachSpeak(session, text, cfg) {
    detach({ kind: "speak", session, text, cfg });
}
export function detachChime(session, chime) {
    detach({ kind: "chime", session, chime });
}
function detach(job) {
    const payloadFile = join(AUDIO_DIR, `job-${process.pid}-${jobCounter++}.json`);
    writeFileSync(payloadFile, JSON.stringify(job));
    const child = spawn(process.execPath, [join(HERE, `player${EXT}`), payloadFile], {
        detached: true,
        stdio: "ignore",
    });
    // Register the pid HERE, not (only) in the player: node takes ~100ms to
    // boot, and during that window playing() would report silence — enough for
    // two near-simultaneous events to both decide the coast is clear.
    if (child.pid) {
        try {
            appendFileSync(pidFile(job.session), `${child.pid}\n`);
        }
        catch {
            /* best effort */
        }
    }
    child.unref();
}
let jobCounter = 0;
/** Is audio (still) playing for this session? Checks pid liveness, not just
 * the pid file, so a crashed player can't wedge milestones forever. */
export function playing(session) {
    try {
        return readFileSync(pidFile(session), "utf8")
            .split("\n")
            .map(Number)
            .filter((n) => Number.isInteger(n) && n > 0)
            .some(alive);
    }
    catch {
        return false;
    }
}
/**
 * Kill any in-flight audio for this session (called from UserPromptSubmit).
 * The pid file holds one pid per line — a chime and a spoken summary can be
 * playing at once (e.g. a notification), and both must die.
 */
export function interrupt(session) {
    try {
        const pids = readFileSync(pidFile(session), "utf8")
            .split("\n")
            .map(Number)
            .filter((n) => Number.isInteger(n) && n > 0);
        for (const pid of pids) {
            try {
                process.kill(-pid, "SIGTERM"); // whole detached group (synth + player)
            }
            catch {
                try {
                    process.kill(pid, "SIGTERM");
                }
                catch {
                    /* already gone */
                }
            }
        }
        unlinkSync(pidFile(session));
    }
    catch {
        /* nothing playing */
    }
}
/** Run one job to completion. The detached player calls this. */
export async function runJob(job) {
    appendFileSync(pidFile(job.session), `${process.pid}\n`);
    try {
        cleanupOldAudio();
        let audioFile;
        if (job.kind === "chime") {
            audioFile = chimeFile(job.chime ?? "attention");
        }
        else if (job.text && job.cfg) {
            audioFile = await synthesize(job.text, job.cfg);
        }
        if (!audioFile)
            return;
        // One voice at a time, machine-wide: synthesis above runs in parallel,
        // but playback queues so concurrent jobs never talk over each other.
        const locked = await acquirePlaybackLock();
        try {
            await playFile(audioFile);
        }
        finally {
            if (locked)
                releasePlaybackLock();
        }
    }
    finally {
        removePid(job.session, process.pid);
    }
}
/** Best-effort: drop our pid from the session's pid file, unlink when empty. */
function removePid(session, pid) {
    try {
        const rest = readFileSync(pidFile(session), "utf8")
            .split("\n")
            .filter((l) => l.trim() && Number(l) !== pid);
        if (rest.length === 0)
            unlinkSync(pidFile(session));
        else
            writeFileSync(pidFile(session), rest.join("\n") + "\n");
    }
    catch {
        /* already gone */
    }
}
async function synthesize(text, cfg) {
    const chosen = getProvider(cfg.provider) ?? defaultProvider();
    try {
        return (await chosen.synthesize({
            text,
            voice: cfg.voice,
            rate: cfg.rate,
            options: cfg.options,
            outDir: AUDIO_DIR,
        })).audioFile;
    }
    catch (err) {
        logDebug(`provider ${chosen.id} failed: ${err.message}; falling back`);
        const fb = defaultProvider();
        if (fb.id === chosen.id)
            throw err;
        return (await fb.synthesize({ text, outDir: AUDIO_DIR })).audioFile;
    }
}
function chimeFile(kind) {
    if (platform() !== "darwin") {
        logDebug(`chime skipped: no system sound on ${platform()}`);
        return undefined; // only bundled system sounds on macOS for now
    }
    return kind === "attention"
        ? "/System/Library/Sounds/Ping.aiff"
        : "/System/Library/Sounds/Glass.aiff";
}
// ── Playback lock (global) ───────────────────────────────────────────────────
// There is one pair of speakers; two voices at once is noise no matter which
// sessions they came from. `wx` creation is the atomic claim; a holder that
// died (interrupt kills players mid-flight) is detected by pid and stolen.
const LOCK_TIMEOUT_MS = 30_000;
function lockPath() {
    return join(process.env.CLAUDE_VOICE_LOCK_DIR ?? tmpdir(), // overridable for tests
    "claude-voice-playback.lock");
}
export async function acquirePlaybackLock(timeoutMs = LOCK_TIMEOUT_MS) {
    const deadline = now() + timeoutMs;
    do {
        try {
            writeFileSync(lockPath(), String(process.pid), { flag: "wx" });
            return true;
        }
        catch {
            try {
                const holder = Number(readFileSync(lockPath(), "utf8"));
                if (!holder || !alive(holder)) {
                    unlinkSync(lockPath()); // stale — next iteration claims it
                    continue;
                }
            }
            catch {
                continue; // lock vanished between checks — retry immediately
            }
            await sleep(150);
        }
    } while (now() < deadline);
    return false; // waited long enough — caller plays anyway (fail open)
}
export function releasePlaybackLock() {
    try {
        if (Number(readFileSync(lockPath(), "utf8")) === process.pid)
            unlinkSync(lockPath());
    }
    catch {
        /* already gone */
    }
}
function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
/** Cross-platform playback of an audio file. */
function playFile(audioFile) {
    const [cmd, args] = playerCommand(audioFile);
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { stdio: "ignore" });
        child.on("exit", () => resolve());
        child.on("error", (e) => {
            logDebug(`playback failed (${cmd}): ${e.message}`);
            resolve();
        });
    });
}
function playerCommand(file) {
    switch (platform()) {
        case "darwin":
            return ["afplay", [file]];
        case "win32":
            return ["powershell", ["-NoProfile", "-c", `(New-Object Media.SoundPlayer '${file}').PlaySync()`]];
        default:
            // Linux: try paplay; players are probed at runtime via error fallthrough.
            return ["paplay", [file]];
    }
}
function cleanupOldAudio() {
    const cutoff = now() - 10 * 60 * 1000;
    try {
        for (const f of readdirSync(AUDIO_DIR)) {
            const p = join(AUDIO_DIR, f);
            try {
                if (statSync(p).mtimeMs < cutoff)
                    unlinkSync(p);
            }
            catch {
                /* skip */
            }
        }
    }
    catch {
        /* dir missing */
    }
}
// Date.now()/new Date() are wrapped so the rest of the file reads cleanly.
function now() {
    return Date.now();
}
function isoNow() {
    return new Date().toISOString();
}
