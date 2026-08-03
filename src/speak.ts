import { spawn } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { VoiceConfig } from "./config.ts";
import { defaultProvider, getProvider } from "./providers/registry.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = join(tmpdir(), "claude-voice-audio");
mkdirSync(AUDIO_DIR, { recursive: true });

/** State files are keyed by session so parallel Claude sessions don't collide. */
const pidFile = (s: string) => join(tmpdir(), `claude-voice-${s}.pid`);
const throttleFile = (s: string) => join(tmpdir(), `claude-voice-${s}.last`);

export function logDebug(msg: string): void {
  if (!process.env.CLAUDE_VOICE_DEBUG) return;
  try {
    appendFileSync(join(tmpdir(), "claude-voice-debug.log"), `${isoNow()} ${msg}\n`);
  } catch {
    /* logging must never throw */
  }
}

// ── Throttle (session-scoped) ────────────────────────────────────────────────
export function throttled(session: string, seconds: number): boolean {
  try {
    return now() - Number(readFileSync(throttleFile(session), "utf8")) < seconds * 1000;
  } catch {
    return false;
  }
}
export function markSpoken(session: string): void {
  try {
    writeFileSync(throttleFile(session), String(now()));
  } catch {
    /* best effort */
  }
}

// ── Non-blocking entry points (used by dispatch) ─────────────────────────────
// Spawn a detached worker that synthesizes + plays, then return immediately so
// the hook exits fast and never stalls the session.
export function detachSpeak(session: string, text: string, cfg: VoiceConfig): void {
  detach({ kind: "speak", session, text, cfg });
}
export function detachChime(session: string, chime: ChimeKind): void {
  detach({ kind: "chime", session, chime });
}

function detach(job: PlayerJob): void {
  const payloadFile = join(AUDIO_DIR, `job-${process.pid}-${jobCounter++}.json`);
  writeFileSync(payloadFile, JSON.stringify(job));
  const child = spawn(process.execPath, [join(HERE, "player.ts"), payloadFile], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
let jobCounter = 0;

/**
 * Kill any in-flight audio for this session (called from UserPromptSubmit).
 * The pid file holds one pid per line — a chime and a spoken summary can be
 * playing at once (e.g. a notification), and both must die.
 */
export function interrupt(session: string): void {
  try {
    const pids = readFileSync(pidFile(session), "utf8")
      .split("\n")
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
    for (const pid of pids) {
      try {
        process.kill(-pid, "SIGTERM"); // whole detached group (synth + player)
      } catch {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
    }
    unlinkSync(pidFile(session));
  } catch {
    /* nothing playing */
  }
}

// ── Blocking worker internals (used by player.ts) ────────────────────────────
export interface PlayerJob {
  kind: "speak" | "chime";
  session: string;
  text?: string;
  chime?: ChimeKind;
  cfg?: VoiceConfig;
}
export type ChimeKind = "attention" | "done";

/** Run one job to completion. The detached player calls this. */
export async function runJob(job: PlayerJob): Promise<void> {
  appendFileSync(pidFile(job.session), `${process.pid}\n`);
  try {
    cleanupOldAudio();
    if (job.kind === "chime") {
      await playChime(job.chime ?? "attention");
    } else if (job.text && job.cfg) {
      await synthesizeAndPlay(job.text, job.cfg);
    }
  } finally {
    removePid(job.session, process.pid);
  }
}

/** Best-effort: drop our pid from the session's pid file, unlink when empty. */
function removePid(session: string, pid: number): void {
  try {
    const rest = readFileSync(pidFile(session), "utf8")
      .split("\n")
      .filter((l) => l.trim() && Number(l) !== pid);
    if (rest.length === 0) unlinkSync(pidFile(session));
    else writeFileSync(pidFile(session), rest.join("\n") + "\n");
  } catch {
    /* already gone */
  }
}

async function synthesizeAndPlay(text: string, cfg: VoiceConfig): Promise<void> {
  const chosen = getProvider(cfg.provider) ?? defaultProvider();
  let audioFile: string;
  try {
    ({ audioFile } = await chosen.synthesize({
      text,
      voice: cfg.voice,
      rate: cfg.rate,
      options: cfg.options,
      outDir: AUDIO_DIR,
    }));
  } catch (err) {
    logDebug(`provider ${chosen.id} failed: ${(err as Error).message}; falling back`);
    const fb = defaultProvider();
    if (fb.id === chosen.id) throw err;
    ({ audioFile } = await fb.synthesize({ text, outDir: AUDIO_DIR }));
  }
  await playFile(audioFile);
}

async function playChime(kind: ChimeKind): Promise<void> {
  if (platform() !== "darwin") {
    logDebug(`chime skipped: no system sound on ${platform()}`);
    return; // only bundled system sounds on macOS for now
  }
  const sound =
    kind === "attention"
      ? "/System/Library/Sounds/Ping.aiff"
      : "/System/Library/Sounds/Glass.aiff";
  await playFile(sound);
}

/** Cross-platform playback of an audio file. */
function playFile(audioFile: string): Promise<void> {
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

function playerCommand(file: string): [string, string[]] {
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

function cleanupOldAudio(): void {
  const cutoff = now() - 10 * 60 * 1000;
  try {
    for (const f of readdirSync(AUDIO_DIR)) {
      const p = join(AUDIO_DIR, f);
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* dir missing */
  }
}

// Date.now()/new Date() are wrapped so the rest of the file reads cleanly.
function now(): number {
  return Date.now();
}
function isoNow(): string {
  return new Date().toISOString();
}
