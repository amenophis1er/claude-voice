import { execFileSync, spawn } from "node:child_process";
import { openSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
/**
 * Kokoro — local neural TTS, fully offline. This module is the UI-free core:
 * paths, install detection, and the lifecycle of the localhost synth server.
 * The interactive install/uninstall/picker lives in kokoro-setup.ts; the
 * TtsProvider in providers/kokoro.ts only calls into here.
 *
 * Everything Kokoro-related lives under KOKORO_DIR (venv, models, server) so
 * uninstalling is a single directory removal — no global pip, no Homebrew.
 */
export const KOKORO_DIR = join(homedir(), ".claude", "voice", "kokoro");
export const MODELS_DIR = join(KOKORO_DIR, "models");
export const VENV_DIR = join(KOKORO_DIR, "venv");
export const SERVER_PY_PATH = join(KOKORO_DIR, "server.py");
export const LOG_FILE = join(KOKORO_DIR, "server.log");
const PORT_FILE = join(KOKORO_DIR, "server.port");
const PID_FILE = join(KOKORO_DIR, "server.pid");
const LOCK_FILE = join(KOKORO_DIR, "server.lock");
/** Written after `pip install` succeeds, so re-running install can skip it. */
export const DEPS_MARKER = join(VENV_DIR, ".deps-ok");
export const DEFAULT_VOICE = "af_heart";
const RELEASE_BASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0";
export const MODEL_VARIANTS = {
    quantized: { file: "kokoro-v1.0.int8.onnx", url: `${RELEASE_BASE}/kokoro-v1.0.int8.onnx`, approxMB: 88, minBytes: 50_000_000 },
    full: { file: "kokoro-v1.0.onnx", url: `${RELEASE_BASE}/kokoro-v1.0.onnx`, approxMB: 310, minBytes: 200_000_000 },
};
export const VOICES_BIN = { file: "voices-v1.0.bin", url: `${RELEASE_BASE}/voices-v1.0.bin`, approxMB: 27, minBytes: 5_000_000 };
export function venvPython() {
    return platform() === "win32" ? join(VENV_DIR, "Scripts", "python.exe") : join(VENV_DIR, "bin", "python");
}
/** Which downloaded model the server will pick up (it prefers full — on
 * Apple Silicon fp32 is ~3x faster than int8, and higher quality). */
export function installedModel() {
    if (fileOk(join(MODELS_DIR, MODEL_VARIANTS.full.file), MODEL_VARIANTS.full.minBytes))
        return "full";
    if (fileOk(join(MODELS_DIR, MODEL_VARIANTS.quantized.file), MODEL_VARIANTS.quantized.minBytes))
        return "quantized";
    return undefined;
}
export function fileOk(path, minBytes) {
    try {
        return statSync(path).size >= minBytes;
    }
    catch {
        return false;
    }
}
export function isInstalled() {
    return Boolean(exists(venvPython()) &&
        exists(DEPS_MARKER) &&
        exists(SERVER_PY_PATH) &&
        installedModel() &&
        fileOk(join(MODELS_DIR, VOICES_BIN.file), VOICES_BIN.minBytes));
}
/** True for CPython 3.10–3.13 — the range with reliable onnxruntime wheels. */
export function pythonVersionOk(versionLine) {
    const m = /(\d+)\.(\d+)/.exec(versionLine);
    if (!m)
        return false;
    const major = Number(m[1]);
    const minor = Number(m[2]);
    return major === 3 && minor >= 10 && minor <= 13;
}
/**
 * Prefer uv: it fetches its own Python 3.12 when the system one is too new
 * (macOS ships bleeding-edge Homebrew Pythons that lag wheel support).
 */
export function findPythonPlan() {
    try {
        const v = execFileSync("uv", ["--version"], { encoding: "utf8" }).trim();
        return { kind: "uv", exe: "uv", detail: `${v} (manages its own Python 3.12)` };
    }
    catch {
        /* no uv */
    }
    for (const exe of ["python3.13", "python3.12", "python3.11", "python3.10", "python3"]) {
        try {
            const v = execFileSync(exe, ["--version"], { encoding: "utf8" }).trim();
            if (pythonVersionOk(v))
                return { kind: "venv", exe, detail: v };
        }
        catch {
            /* not on PATH */
        }
    }
    return undefined;
}
// ── Server lifecycle ─────────────────────────────────────────────────────────
// The server starts on demand, binds an ephemeral localhost port (written to
// PORT_FILE), and exits by itself after 10 idle minutes — it is not a daemon.
/** Port of a live, responding server — or undefined. */
export async function livePort() {
    try {
        const port = Number(readFileSync(PORT_FILE, "utf8").trim());
        if (port > 0 && (await healthy(port)))
            return port;
    }
    catch {
        /* no port file */
    }
    return undefined;
}
async function healthy(port) {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_500) });
        return res.ok;
    }
    catch {
        return false;
    }
}
/**
 * Fire-and-forget warmup, called from the (synchronous) prompt-submit hook:
 * no fetch, no waiting — a pid liveness check and possibly a detached spawn.
 * By the time the task's summary wants audio, the model is already loaded.
 */
export function warmServer() {
    if (!isInstalled())
        return;
    try {
        const pid = Number(readFileSync(PID_FILE, "utf8").trim());
        if (pid > 0 && alive(pid))
            return;
    }
    catch {
        /* not running */
    }
    claimAndSpawn();
}
/** Ensure a responding server, spawning one if needed. Returns its port. */
export async function ensureServer(timeoutMs = 30_000) {
    const existing = await livePort();
    if (existing)
        return existing;
    claimAndSpawn();
    try {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const port = await livePort();
            if (port)
                return port;
            await sleep(250);
        }
    }
    finally {
        releaseLockIfOurs();
    }
    throw new Error(`kokoro server did not come up within ${timeoutMs / 1000}s — see ${LOG_FILE}`);
}
/**
 * At most one spawner at a time: `wx` file creation is the atomic claim
 * (same pattern as the playback lock in speak.ts). Losing the claim is fine —
 * the winner's server satisfies our health poll too.
 */
function claimAndSpawn() {
    try {
        writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx" });
    }
    catch {
        try {
            const holder = Number(readFileSync(LOCK_FILE, "utf8"));
            if (holder > 0 && alive(holder))
                return; // someone else is spawning
            unlinkSync(LOCK_FILE);
            writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx" });
        }
        catch {
            return; // lost the race — poll for the winner's server
        }
    }
    rmSync(PORT_FILE, { force: true }); // a stale port must not satisfy the poll
    try {
        const log = openSync(LOG_FILE, "a");
        const child = spawn(venvPython(), [SERVER_PY_PATH], {
            detached: true, // own process group: survives hook/player interrupts
            stdio: ["ignore", log, log],
            cwd: KOKORO_DIR,
        });
        child.unref();
    }
    catch {
        releaseLockIfOurs(); // spawn failed → let the next caller try
    }
}
function releaseLockIfOurs() {
    try {
        if (Number(readFileSync(LOCK_FILE, "utf8")) === process.pid)
            unlinkSync(LOCK_FILE);
    }
    catch {
        /* already gone */
    }
}
/** Kill a running server (uninstall / manual stop). True if one was running. */
export function stopServer() {
    let stopped = false;
    try {
        const pid = Number(readFileSync(PID_FILE, "utf8").trim());
        if (pid > 0 && alive(pid)) {
            process.kill(pid, "SIGTERM");
            stopped = true;
        }
    }
    catch {
        /* not running */
    }
    rmSync(PORT_FILE, { force: true });
    rmSync(PID_FILE, { force: true });
    rmSync(LOCK_FILE, { force: true });
    return stopped;
}
// ── Synthesis ────────────────────────────────────────────────────────────────
export async function synthesizeWav(text, opts) {
    const port = await ensureServer();
    const res = await fetch(`http://127.0.0.1:${port}/synth`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            text,
            voice: opts?.voice ?? DEFAULT_VOICE,
            speed: opts?.speed ?? 1,
        }),
        signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok)
        throw new Error(`kokoro server ${res.status}: ${await res.text()}`);
    return Buffer.from(await res.arrayBuffer());
}
/** All voice ids shipped in the voices file, from a live server. */
export async function serverVoices() {
    const port = await ensureServer();
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
    const data = (await res.json());
    return data.voices ?? [];
}
// ── Small shared helpers ─────────────────────────────────────────────────────
function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function exists(path) {
    try {
        statSync(path);
        return true;
    }
    catch {
        return false;
    }
}
export function dirSizeBytes(dir) {
    let total = 0;
    try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, entry.name);
            if (entry.isDirectory())
                total += dirSizeBytes(p);
            else {
                try {
                    total += statSync(p).size;
                }
                catch {
                    /* skip */
                }
            }
        }
    }
    catch {
        /* missing dir → 0 */
    }
    return total;
}
export function formatBytes(bytes) {
    if (bytes >= 1_000_000_000)
        return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
    if (bytes >= 1_000_000)
        return `${Math.round(bytes / 1_000_000)} MB`;
    if (bytes >= 1_000)
        return `${Math.round(bytes / 1_000)} kB`;
    return `${bytes} B`;
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
/**
 * The localhost synth server, written to KOKORO_DIR at install time. Embedded
 * as a string (not a shipped .py file) so the tsc build and npm packaging
 * stay untouched. Stdlib + kokoro-onnx only; exits after 10 idle minutes.
 */
export const SERVER_PY = `#!/usr/bin/env python3
"""Local Kokoro TTS server for claude-voice.

Written by \`claude-voice kokoro install\` — do not edit; reinstalling
overwrites it. Binds an ephemeral localhost port (written to server.port),
serves POST /synth and GET /health, and exits on its own after 10 minutes
without a request. Stdlib + kokoro-onnx only.
"""
import io
import json
import os
import signal
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
from kokoro_onnx import Kokoro

BASE = Path(__file__).resolve().parent
MODELS = BASE / "models"
PORT_FILE = BASE / "server.port"
PID_FILE = BASE / "server.pid"
IDLE_EXIT_SECONDS = 600


def find_model():
    # Full first: on Apple Silicon fp32 is ~3x FASTER than int8 (and higher
    # quality) — quantized only wins on disk. Measured on an M5 Pro.
    for name in ("kokoro-v1.0.onnx", "kokoro-v1.0.int8.onnx"):
        p = MODELS / name
        if p.exists():
            return p
    sys.exit("no kokoro model found in %s" % MODELS)


kokoro = Kokoro(str(find_model()), str(MODELS / "voices-v1.0.bin"))
state_lock = threading.Lock()
last_request = time.time()
in_flight = 0


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # quiet; errors go to stderr -> server.log

    def _send(self, status, body, ctype):
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path != "/health":
            self.send_error(404)
            return
        body = json.dumps({"ok": True, "voices": sorted(kokoro.get_voices())}).encode()
        self._send(200, body, "application/json")

    def do_POST(self):
        global last_request, in_flight
        if self.path != "/synth":
            self.send_error(404)
            return
        with state_lock:
            in_flight += 1
            last_request = time.time()
        try:
            n = int(self.headers.get("content-length") or 0)
            req = json.loads(self.rfile.read(n) or b"{}")
            samples, rate = kokoro.create(
                req.get("text", ""),
                voice=req.get("voice") or "af_heart",
                speed=float(req.get("speed") or 1.0),
                lang=req.get("lang") or "en-us",
            )
            pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
            buf = io.BytesIO()
            with wave.open(buf, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(rate)
                w.writeframes(pcm.tobytes())
            self._send(200, buf.getvalue(), "audio/wav")
        except Exception as e:
            self._send(500, str(e).encode(), "text/plain")
        finally:
            with state_lock:
                in_flight -= 1
                last_request = time.time()


def cleanup(*_):
    for f in (PORT_FILE, PID_FILE):
        try:
            f.unlink()
        except OSError:
            pass
    os._exit(0)


def watchdog():
    while True:
        time.sleep(30)
        with state_lock:
            idle = in_flight == 0 and time.time() - last_request > IDLE_EXIT_SECONDS
        if idle:
            cleanup()


signal.signal(signal.SIGTERM, cleanup)
server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
tmp = PORT_FILE.with_suffix(".tmp")
tmp.write_text(str(server.server_address[1]))
tmp.replace(PORT_FILE)  # atomic: readers never see a half-written port
PID_FILE.write_text(str(os.getpid()))
threading.Thread(target=watchdog, daemon=True).start()
# JIT-warm the inference session so even the first real utterance is fast.
threading.Thread(target=lambda: kokoro.create("Ready.", voice="af_heart"), daemon=True).start()
server.serve_forever()
`;
