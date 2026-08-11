import { spawn } from "node:child_process";
import { chmodSync, createWriteStream, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ui from "./ui.js";
import { CONFIG_PATH, loadConfig } from "./config.js";
import { playFile, playerCommand } from "./speak.js";
import { DEFAULT_VOICE, DEPS_MARKER, KOKORO_DIR, LOG_FILE, MODELS_DIR, MODEL_VARIANTS, SERVER_PY, SERVER_PY_PATH, VENV_DIR, VOICES_BIN, dirSizeBytes, ensureServer, fileOk, findPythonPlan, formatBytes, installedModel, isInstalled, livePort, serverVoices, stopServer, synthesizeWav, venvPython, } from "./kokoro.js";
/**
 * Interactive install / uninstall / status / voice picker for Kokoro.
 * Kept out of kokoro.ts so the hook/player path never loads the UI code.
 *
 * Every step is idempotent: a failed or interrupted install is finished by
 * simply re-running it, and `kokoro uninstall` removes a partial install
 * just as completely as a finished one (everything lives under KOKORO_DIR).
 */
/**
 * The ten best-regarded Kokoro v1.0 voices, so picking is listening to a
 * shortlist — not scrolling 50 opaque ids. "All voices" is the escape hatch.
 */
const CURATED_VOICES = [
    { id: "af_heart", hint: "American female, warm — default" },
    { id: "af_bella", hint: "American female, bright" },
    { id: "af_nicole", hint: "American female, soft-spoken" },
    { id: "af_sky", hint: "American female, clear" },
    { id: "am_michael", hint: "American male, neutral" },
    { id: "am_fenrir", hint: "American male, deep" },
    { id: "am_puck", hint: "American male, upbeat" },
    { id: "bf_emma", hint: "British female" },
    { id: "bm_george", hint: "British male" },
    { id: "bm_fable", hint: "British male, storyteller" },
];
const PREVIEW_TEXT = "This is how I'll sound when your task finishes.";
/**
 * The whole flow: preflight → venv + deps → model download → server.py →
 * smoke test you can hear → voice picker → (optionally) config switch.
 * With writeConfig=false (init runs us) the caller owns the config file and
 * we just hand back the chosen voice.
 */
export async function installKokoro(opts) {
    const writeConfig = opts?.writeConfig ?? true;
    if (writeConfig)
        ui.intro("kokoro", "local neural TTS — offline, free, no API key");
    // 1. Python. uv is preferred (fetches its own 3.12); else a system 3.10–3.13.
    const plan = findPythonPlan();
    if (!plan) {
        throw new Error([
            "No usable Python found. Kokoro needs Python 3.10–3.13 (onnxruntime wheels).",
            "Easiest fix: `brew install uv` — it fetches its own Python, nothing global changes.",
        ].join("\n"));
    }
    ui.step("Python", plan.detail);
    // 2. Venv + kokoro-onnx (skipped when the deps marker says it's done).
    mkdirSync(MODELS_DIR, { recursive: true });
    if (!fileOk(DEPS_MARKER, 0)) {
        const s = ui.spinner("Installing kokoro-onnx into a private venv");
        try {
            if (plan.kind === "uv") {
                await run("uv", ["venv", "--python", "3.12", VENV_DIR]);
                await run("uv", ["pip", "install", "--python", venvPython(), "kokoro-onnx"]);
            }
            else {
                await run(plan.exe, ["-m", "venv", VENV_DIR]);
                await run(venvPython(), ["-m", "pip", "install", "--quiet", "kokoro-onnx"]);
            }
        }
        catch (err) {
            s.stop("venv install failed");
            throw err;
        }
        writeFileSync(DEPS_MARKER, "");
        s.stop(`Dependencies installed ${ui.dim(`(${VENV_DIR})`)}`);
    }
    else {
        ui.step("Dependencies", "already installed");
    }
    // 3. Model. Full is the default: on Apple Silicon fp32 runs ~3× faster
    // than int8 AND sounds better — quantized only wins on disk space.
    let variant = installedModel();
    if (!variant) {
        variant = await ui.select("Model size", [
            { value: "full", label: "full", hint: `~${MODEL_VARIANTS.full.approxMB} MB — recommended: fastest on Apple Silicon, best quality` },
            { value: "quantized", label: "quantized", hint: `~${MODEL_VARIANTS.quantized.approxMB} MB — smallest download, ~3× slower on M-series` },
        ], 0);
    }
    else {
        ui.step("Model", `${variant} (already downloaded)`);
    }
    await downloadIfMissing(MODEL_VARIANTS[variant]);
    await downloadIfMissing(VOICES_BIN);
    // 4. The server script — always rewritten so upgrades take effect.
    writeFileSync(SERVER_PY_PATH, SERVER_PY);
    ui.step("Server", `written ${ui.dim(`(${SERVER_PY_PATH})`)}`);
    // 5. Smoke test: the install ends with you hearing it work.
    const s = ui.spinner("Starting local server (first model load)");
    await ensureServer();
    s.stop("Server up — synthesizing a test phrase");
    const wav = await synthesizeWav("Kokoro is installed and running locally.");
    const testFile = join(tmpdir(), `claude-voice-kokoro-test-${process.pid}.wav`);
    writeFileSync(testFile, wav);
    await playFile(testFile);
    rmSync(testFile, { force: true });
    // 6. Hear-and-choose voice.
    const voice = await pickVoice({ save: false });
    // 7. Config.
    if (writeConfig) {
        const use = await ui.confirm("Use Kokoro as your voice provider now?", true);
        updateConfig((cfg) => {
            if (use)
                cfg.provider = "kokoro";
            cfg.voice = voice;
        });
        ui.close();
        ui.outro([
            use
                ? `${ui.bold("Kokoro is your voice provider.")} Everything runs locally.`
                : `Installed. Switch any time: set ${ui.cyan('"provider": "kokoro"')} in config, or re-run ${ui.cyan("claude-voice init")}.`,
            `${ui.dim("voice:")} ${voice}   ${ui.dim("change:")} claude-voice kokoro voice`,
            `${ui.dim("footprint:")} ${formatBytes(dirSizeBytes(KOKORO_DIR))} in ${KOKORO_DIR}`,
            `${ui.dim("remove completely:")} claude-voice kokoro uninstall`,
        ]);
    }
    return { voice };
}
/**
 * The picker: arrow through a curated shortlist and each voice introduces
 * itself as you land on it (synth is local + warm, so this is instant-ish).
 * Piped/non-TTY runs get the numbered fallback with no previews.
 */
export async function pickVoice(opts) {
    if (!isInstalled())
        throw new Error("Kokoro is not installed — run `claude-voice kokoro install`");
    await ensureServer();
    const current = loadConfig().voice;
    const options = [
        ...CURATED_VOICES.map((v) => ({ value: v.id, label: v.id, hint: v.hint })),
        { value: "__all__", label: "all voices…", hint: "browse everything in the voice pack" },
    ];
    const initial = Math.max(0, options.findIndex((o) => o.value === current));
    let voice = await ui.select("Voice (each one speaks as you land on it)", options, initial, schedulePreview);
    if (voice === "__all__") {
        const all = await serverVoices();
        voice = await ui.select("Voice", all.map((v) => ({ value: v, label: v })), Math.max(0, all.indexOf(current ?? DEFAULT_VOICE)), schedulePreview);
    }
    stopPreview();
    if (opts.save) {
        updateConfig((cfg) => {
            cfg.voice = voice;
        });
        console.log(`Saved: voice = ${voice} (${CONFIG_PATH})`);
    }
    return voice;
}
/** Stop the server, delete KOKORO_DIR, and point config back at the default. */
export async function uninstallKokoro() {
    const size = dirSizeBytes(KOKORO_DIR);
    if (size === 0) {
        console.log("Kokoro is not installed — nothing to remove.");
        return;
    }
    const ok = await ui.confirm(`Remove Kokoro completely? (${formatBytes(size)} in ${KOKORO_DIR})`, true);
    ui.close();
    if (!ok) {
        console.log("Kept as-is.");
        return;
    }
    const wasRunning = stopServer();
    rmSync(KOKORO_DIR, { recursive: true, force: true });
    if (loadConfig().provider === "kokoro") {
        updateConfig((cfg) => {
            cfg.provider = "system";
            delete cfg.voice; // a kokoro voice id means nothing to the system voice
        });
        console.log("Provider reset to the system voice.");
    }
    console.log(`Removed ${KOKORO_DIR} (${formatBytes(size)} freed${wasRunning ? ", server stopped" : ""}).`);
}
export async function kokoroStatus() {
    if (!isInstalled()) {
        const partial = dirSizeBytes(KOKORO_DIR);
        return partial
            ? `not installed (a ${formatBytes(partial)} partial install remains — re-run \`claude-voice kokoro install\` or \`kokoro uninstall\`)`
            : "not installed — run `claude-voice kokoro install`";
    }
    const cfg = loadConfig();
    const port = await livePort();
    return [
        `installed:  yes (${installedModel()} model)`,
        `disk:       ${formatBytes(dirSizeBytes(KOKORO_DIR))} · ${KOKORO_DIR}`,
        `server:     ${port ? `warm · port ${port}` : "cold (starts on demand, exits after 10 idle minutes)"}`,
        `active:     ${cfg.provider === "kokoro" ? `yes · voice ${cfg.voice ?? DEFAULT_VOICE}` : `no (provider is ${cfg.provider})`}`,
        `log:        ${LOG_FILE}`,
    ].join("\n");
}
// ── Preview playback ─────────────────────────────────────────────────────────
// Debounced (arrowing through the list must not synth every voice passed
// over) and sequenced (a slow synth resolving late must not speak the wrong
// voice). Samples are cached per voice, so revisiting is instant.
let previewTimer;
let previewProc;
let previewSeq = 0;
const previewCache = new Map();
function schedulePreview(voice) {
    if (voice === "__all__")
        return;
    clearTimeout(previewTimer);
    const seq = ++previewSeq;
    previewTimer = setTimeout(() => void playPreview(voice, seq), 250);
}
async function playPreview(voice, seq) {
    try {
        let file = previewCache.get(voice);
        if (!file) {
            const wav = await synthesizeWav(PREVIEW_TEXT, { voice });
            file = join(tmpdir(), `claude-voice-preview-${voice}.wav`);
            writeFileSync(file, wav);
            previewCache.set(voice, file);
        }
        if (seq !== previewSeq)
            return; // user moved on while we synthesized
        previewProc?.kill();
        const [cmd, args] = playerCommand(file);
        previewProc = spawn(cmd, args, { stdio: "ignore" });
    }
    catch {
        /* previews are best-effort — selection still works silently */
    }
}
function stopPreview() {
    clearTimeout(previewTimer);
    previewSeq++;
    previewProc?.kill();
    for (const f of previewCache.values())
        rmSync(f, { force: true });
    previewCache.clear();
}
// ── Plumbing ─────────────────────────────────────────────────────────────────
/** Download to name.part, then rename — a crash never leaves a fake model. */
async function downloadIfMissing(mf) {
    const dest = join(MODELS_DIR, mf.file);
    if (fileOk(dest, mf.minBytes)) {
        ui.step("Download", `${mf.file} (already present)`);
        return;
    }
    const res = await fetch(mf.url, { redirect: "follow" });
    if (!res.ok || !res.body)
        throw new Error(`download failed (${res.status}): ${mf.url}`);
    const total = Number(res.headers.get("content-length")) || mf.approxMB * 1_000_000;
    const part = `${dest}.part`;
    const out = createWriteStream(part);
    let done = 0;
    let lastDrawn = -1;
    for await (const chunk of res.body) {
        done += chunk.length;
        if (!out.write(chunk))
            await new Promise((r) => out.once("drain", () => r()));
        const pct = Math.min(99, Math.floor((done / total) * 100));
        if (pct !== lastDrawn && process.stdout.isTTY) {
            process.stdout.write(`\r${ui.cyan("↓")} ${mf.file} ${ui.dim(`${formatBytes(done)} · ${pct}%`)}   `);
            lastDrawn = pct;
        }
    }
    await new Promise((r) => out.end(() => r()));
    if (!fileOk(part, mf.minBytes)) {
        rmSync(part, { force: true });
        throw new Error(`${mf.file} came down truncated (${formatBytes(done)}) — re-run the install`);
    }
    renameSync(part, dest);
    if (process.stdout.isTTY)
        process.stdout.write("\r\x1b[K");
    ui.step("Download", `${mf.file} (${formatBytes(done)})`);
}
/** Merge-edit config.json the way init does: never clobber other fields. */
function updateConfig(mutate) {
    let cfg = {};
    try {
        cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    }
    catch {
        /* first run */
    }
    mutate(cfg);
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
    chmodSync(CONFIG_PATH, 0o600); // may hold an api_key
}
/** Async exec that keeps the spinner animating; rejects with stderr's tail. */
function run(cmd, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += d.toString()));
        child.on("error", reject);
        child.on("exit", (code) => {
            if (code === 0)
                resolve();
            else
                reject(new Error(`${cmd} ${args[0]} failed (exit ${code}):\n${stderr.trim().split("\n").slice(-8).join("\n")}`));
        });
    });
}
