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
import { recordMetric, type UtteranceRecord } from "./metrics.ts";
import { defaultProvider, getProvider } from "./providers/registry.ts";
import type { SynthesizeResult, TtsProvider } from "./providers/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** ".ts" when running straight from source (Node 23.6+), ".js" from dist/. */
const EXT = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
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
export function detachSpeak(
  session: string,
  text: string,
  cfg: VoiceConfig,
  opts?: { expendable?: boolean; event?: string },
): void {
  detach({ kind: "speak", session, text, cfg, expendable: opts?.expendable, event: opts?.event });
}
export function detachChime(session: string, chime: ChimeKind, event?: string): void {
  detach({ kind: "chime", session, chime, event });
}

function detach(job: PlayerJob): void {
  job.emittedAt = now();
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
    } catch {
      /* best effort */
    }
  }
  child.unref();
}
let jobCounter = 0;

/** Is audio (still) playing for this session? Checks pid liveness, not just
 * the pid file, so a crashed player can't wedge milestones forever. */
export function playing(session: string): boolean {
  try {
    return readFileSync(pidFile(session), "utf8")
      .split("\n")
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)
      .some(alive);
  } catch {
    return false;
  }
}

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

/**
 * Kill ALL in-flight claude-voice audio, across every session — the panic
 * button behind `claude-voice stop` and its hotkey Shortcut. Returns how many
 * sessions had a pid file (0 = nothing was playing).
 */
export function interruptAll(): number {
  let sessions = 0;
  try {
    for (const f of readdirSync(tmpdir())) {
      const m = /^claude-voice-(.+)\.pid$/.exec(f);
      if (!m) continue;
      sessions++;
      interrupt(m[1]!);
    }
  } catch {
    /* tmpdir unreadable — nothing to stop */
  }
  return sessions;
}

// ── Blocking worker internals (used by player.ts) ────────────────────────────
export interface PlayerJob {
  kind: "speak" | "chime";
  session: string;
  text?: string;
  chime?: ChimeKind;
  cfg?: VoiceConfig;
  /** Time-sensitive audio (milestones): drop it if the speaker is busy. */
  expendable?: boolean;
  /** Which hook event / CLI command produced this job (for metrics). */
  event?: string;
  /** Stamped by detach() so the worker can measure dispatch → audible. */
  emittedAt?: number;
}
export type ChimeKind = "attention" | "done";

/** Run one job to completion. The detached player calls this. */
export async function runJob(job: PlayerJob): Promise<void> {
  appendFileSync(pidFile(job.session), `${process.pid}\n`);
  const metric: UtteranceRecord = {
    t: "utterance",
    ts: job.emittedAt ?? now(),
    event: job.event,
    kind: job.kind,
    session: job.session,
    outcome: "no-audio",
  };
  if (job.emittedAt) metric.emitToWorkerMs = now() - job.emittedAt;
  try {
    cleanupOldAudio();
    let audioFile: string | undefined;
    if (job.kind === "chime") {
      audioFile = chimeFile(job.chime ?? "attention");
      metric.provider = "chime";
    } else if (job.text && job.cfg) {
      // Streaming providers (kokoro) start playing after the FIRST sentence
      // and synthesize the rest during playback — near-constant perceived
      // latency however long the summary is. A pre-audio failure falls
      // through to the buffered path below, which has its own fallback.
      const chosen = getProvider(job.cfg.provider) ?? defaultProvider();
      if (chosen.synthesizeStream && (await runStreamingSpeak(job, chosen, metric))) return;
      const t0 = now();
      const synth = await synthesize(job.text, job.cfg);
      metric.synthMs = now() - t0;
      metric.provider = synth.provider;
      if (synth.fallback) metric.fallback = true;
      audioFile = synth.audioFile;
    }
    if (!audioFile) return;
    // One voice at a time, machine-wide: synthesis above runs in parallel,
    // but playback queues so concurrent jobs never talk over each other.
    // Expendable audio gets a short grace, then is dropped — by the time the
    // speaker frees up, the moment it narrated is gone.
    const q0 = now();
    const locked = await acquirePlaybackLock(job.expendable ? 3_000 : undefined);
    metric.queueWaitMs = now() - q0;
    if (!locked && job.expendable) {
      metric.outcome = "dropped-busy";
      logDebug("expendable audio dropped: speaker busy");
      return;
    }
    try {
      const p0 = now();
      if (job.emittedAt) metric.totalMs = p0 - job.emittedAt;
      await playFile(audioFile);
      metric.playMs = now() - p0;
      metric.outcome = "played";
    } finally {
      if (locked) releasePlaybackLock();
    }
  } catch (err) {
    metric.outcome = "error";
    throw err;
  } finally {
    removePid(job.session, process.pid);
    recordMetric(metric);
  }
}

/**
 * The pipelined speak path: pull chunk n+1 from the provider WHILE chunk n
 * plays. Owns lock + metrics for its whole run. Returns false only when no
 * audio was produced yet (caller retries via the buffered path); once the
 * listener has heard anything, errors just end the stream early.
 */
async function runStreamingSpeak(
  job: PlayerJob,
  provider: TtsProvider,
  metric: UtteranceRecord,
): Promise<boolean> {
  const gen = provider.synthesizeStream!({
    text: job.text!,
    voice: job.cfg!.voice,
    rate: job.cfg!.rate,
    options: job.cfg!.options,
    outDir: AUDIO_DIR,
  });
  const t0 = now();
  let first: IteratorResult<SynthesizeResult>;
  try {
    first = await gen.next();
  } catch (err) {
    logDebug(`streaming synth failed pre-audio (${provider.id}): ${(err as Error).message}`);
    return false;
  }
  if (first.done) return false;
  metric.synthMs = now() - t0; // time to FIRST audible chunk — the number that matters
  metric.provider = provider.id;

  const q0 = now();
  const locked = await acquirePlaybackLock(job.expendable ? 3_000 : undefined);
  metric.queueWaitMs = now() - q0;
  if (!locked && job.expendable) {
    metric.outcome = "dropped-busy";
    logDebug("expendable audio dropped: speaker busy");
    return true;
  }
  try {
    const p0 = now();
    if (job.emittedAt) metric.totalMs = p0 - job.emittedAt;
    let cur: IteratorResult<SynthesizeResult> = first;
    while (!cur.done) {
      const next = gen.next(); // synthesis of n+1 overlaps playback of n
      await playFile(cur.value.audioFile);
      try {
        cur = await next;
      } catch (err) {
        logDebug(`streaming synth failed mid-stream (${provider.id}): ${(err as Error).message}`);
        break; // the start was heard; a half summary beats a repeated one
      }
    }
    metric.playMs = now() - p0;
    metric.outcome = "played";
  } finally {
    if (locked) releasePlaybackLock();
  }
  return true;
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

async function synthesize(
  text: string,
  cfg: VoiceConfig,
): Promise<{ audioFile: string; provider: string; fallback: boolean }> {
  const chosen = getProvider(cfg.provider) ?? defaultProvider();
  try {
    const r = await chosen.synthesize({
      text,
      voice: cfg.voice,
      rate: cfg.rate,
      options: cfg.options,
      outDir: AUDIO_DIR,
    });
    return { audioFile: r.audioFile, provider: chosen.id, fallback: false };
  } catch (err) {
    logDebug(`provider ${chosen.id} failed: ${(err as Error).message}; falling back`);
    const fb = defaultProvider();
    if (fb.id === chosen.id) throw err;
    const r = await fb.synthesize({ text, outDir: AUDIO_DIR });
    return { audioFile: r.audioFile, provider: fb.id, fallback: true };
  }
}

function chimeFile(kind: ChimeKind): string | undefined {
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

function lockPath(): string {
  return join(
    process.env.CLAUDE_VOICE_LOCK_DIR ?? tmpdir(), // overridable for tests
    "claude-voice-playback.lock",
  );
}

export async function acquirePlaybackLock(timeoutMs = LOCK_TIMEOUT_MS): Promise<boolean> {
  const deadline = now() + timeoutMs;
  do {
    try {
      writeFileSync(lockPath(), String(process.pid), { flag: "wx" });
      return true;
    } catch {
      try {
        const holder = Number(readFileSync(lockPath(), "utf8"));
        if (!holder || !alive(holder)) {
          unlinkSync(lockPath()); // stale — next iteration claims it
          continue;
        }
      } catch {
        continue; // lock vanished between checks — retry immediately
      }
      await sleep(150);
    }
  } while (now() < deadline);
  return false; // waited long enough — caller plays anyway (fail open)
}

export function releasePlaybackLock(): void {
  try {
    if (Number(readFileSync(lockPath(), "utf8")) === process.pid) unlinkSync(lockPath());
  } catch {
    /* already gone */
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Cross-platform playback of an audio file. Also used by the kokoro setup
 * flow (smoke test + voice previews), hence exported. On Linux, tries each
 * known player in order — paplay (Pulse/PipeWire) then aplay (bare ALSA). */
export function playFile(audioFile: string): Promise<void> {
  return new Promise((resolve) => {
    const candidates = playerCommands(audioFile);
    const tryNext = (i: number): void => {
      if (i >= candidates.length) {
        logDebug(`playback failed: no player available for ${audioFile}`);
        resolve();
        return;
      }
      const [cmd, args] = candidates[i]!;
      const child = spawn(cmd, args, { stdio: "ignore" });
      child.on("exit", (code) => {
        if (code === 0 || i === candidates.length - 1) resolve();
        else tryNext(i + 1); // player ran but rejected the file — try the next
      });
      child.on("error", () => tryNext(i + 1)); // ENOENT: player not installed
    };
    tryNext(0);
  });
}

/** All playback candidates for this platform, in preference order. */
function playerCommands(file: string): [string, string[]][] {
  switch (platform()) {
    case "darwin":
      return [["afplay", [file]]];
    case "win32":
      return [
        ["powershell", ["-NoProfile", "-c", `(New-Object Media.SoundPlayer '${file}').PlaySync()`]],
      ];
    default:
      return [
        ["paplay", [file]],
        ["aplay", [file]],
      ];
  }
}

/** First-choice playback command for this platform. Used by kokoro-setup's
 * voice previews (which spawn and kill the player themselves). */
export function playerCommand(file: string): [string, string[]] {
  return playerCommands(file)[0]!;
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
