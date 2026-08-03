#!/usr/bin/env node
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as ui from "./ui.ts";
import { CONFIG_PATH, loadConfig, type Preset, type VoiceConfig } from "./config.ts";
import { listProviders } from "./providers/registry.ts";
import { install, listSystemVoices, uninstall } from "./install.ts";
import { mute, muteStatus, unmute } from "./mute.ts";
import { detachChime, detachSpeak } from "./speak.ts";

const cmd = process.argv[2];

switch (cmd) {
  case "mute":
    try {
      console.log(mute(process.argv[3]));
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
    break;

  case "unmute":
    console.log(unmute());
    break;

  case "status": {
    const c = loadConfig();
    console.log(`preset: ${c.preset} · provider: ${c.provider} · ${muteStatus()}`);
    break;
  }

  case "list":
    for (const p of listProviders()) {
      console.log(`${p.id.padEnd(12)} ${p.zeroConfig ? "•" : " "}  ${p.label}`);
    }
    console.log("\n• = zero-config (no API key needed)");
    break;

  case "voices": {
    const v = listSystemVoices();
    console.log(v.length ? v.join("\n") : "(no system voices detected on this platform)");
    break;
  }

  case "test": {
    const text = process.argv.slice(3).join(" ") || "Claude voice is working.";
    detachChime("cli-test", "done");
    detachSpeak("cli-test", text, loadConfig());
    console.log("Playing… (detached)");
    break;
  }

  case "config":
    console.log(CONFIG_PATH);
    console.log(JSON.stringify(loadConfig(), null, 2));
    break;

  case "install":
    console.log("Wired claude-voice hooks into", install());
    break;

  case "uninstall":
    console.log("Removed claude-voice hooks from", uninstall());
    break;

  case "init":
    await init();
    break;

  default:
    console.log(
      [
        "claude-voice — give Claude Code a voice (quiet by default)",
        "",
        "  claude-voice init            interactive setup (recommended)",
        "  claude-voice install         wire hooks into ~/.claude/settings.json",
        "  claude-voice uninstall       remove the hooks",
        "  claude-voice list            list TTS providers",
        "  claude-voice voices          list system voices",
        "  claude-voice test [text]     synthesize and play a phrase",
        "  claude-voice config          show active config + its path",
        "  claude-voice mute [30m|2h|1d]  mute all audio (no duration = until unmute)",
        "  claude-voice unmute          lift a mute",
        "  claude-voice status          preset, provider, mute state",
      ].join("\n"),
    );
}

async function init(): Promise<void> {
  ui.intro("claude-voice", "give Claude Code a voice — quiet by default");

  const preset = await ui.select<Preset>(
    "How chatty should it be?",
    [
      { value: "summary", label: "summary", hint: "spoken wrap-up after substantial tasks — recommended" },
      { value: "chimes", label: "chimes", hint: "sounds only, never speech" },
      { value: "verbose", label: "verbose", hint: "speak after every task + mid-task milestones" },
      { value: "silent", label: "silent", hint: "install now, enable later" },
    ],
    0,
  );

  const PROVIDER_HINTS: Record<string, string> = {
    system: "no API key, works offline",
    elevenlabs: "ElevenLabs — needs an API key",
    openai: "OpenAI or any OpenAI-compatible server (Kokoro, LocalAI, …)",
  };
  const provider = await ui.select<string>(
    "Voice provider",
    listProviders().map((p) => ({
      value: p.id,
      label: p.id,
      hint: PROVIDER_HINTS[p.id] ?? p.label,
    })),
    0,
  );

  // Merge over any existing config: re-running init must never clobber
  // hand-edited fields (thresholds, quiet hours, provider extras).
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    /* first run */
  }
  const options: Record<string, unknown> = { ...((existing.options as object) ?? {}) };

  if (provider === "openai") {
    let url = await ui.text("Endpoint URL", "blank = api.openai.com — any OpenAI-compatible server");
    if (url) {
      if (!/^https?:\/\//.test(url)) url = `https://${url}`; // scheme is easy to forget
      const u = new URL(url);
      if (u.pathname === "/" || u.pathname === "") u.pathname = "/v1"; // OpenAI-compatible convention
      options.baseUrl = u.toString().replace(/\/+$/, "");
      ui.step("Endpoint", String(options.baseUrl));
    } else delete options.baseUrl;
  }
  if (provider === "openai" || provider === "elevenlabs") {
    const envVar = provider === "openai" ? "OPENAI_API_KEY" : "ELEVENLABS_API_KEY";
    const current = options.api_key ? 1 : options.apiKeyCommand ? 2 : 0;
    const keyMode = await ui.select<string>(
      "API key",
      [
        { value: "env", label: `use $${envVar}`, hint: "already exported in your shell rc / profile" },
        { value: "paste", label: "paste it now", hint: "stored in config.json (file mode 600)" },
        { value: "cmd", label: "fetch via a command", hint: "e.g. op read op://vault/item/credential" },
      ],
      current,
    );
    delete options.api_key;
    delete options.apiKeyCommand;
    if (keyMode === "paste") {
      options.api_key = await ui.text("Paste key", "input is kept, display is masked", (s) =>
        s.length > 8 ? `${s.slice(0, 5)}…${s.slice(-3)}` : "•••",
      );
    } else if (keyMode === "cmd") {
      options.apiKeyCommand = await ui.text("Command", "stdout must be the key");
    }
  }

  let voice = "";
  if (provider === "system") {
    const voices = listSystemVoices();
    if (voices.length) {
      const curated = voices.slice(0, 7);
      voice = await ui.select<string>(
        "Voice",
        [
          { value: "", label: "system default" },
          ...curated.map((v) => ({ value: v, label: v })),
          { value: "__other__", label: "other…", hint: `${voices.length} installed — see \`claude-voice voices\`` },
        ],
        0,
      );
      if (voice === "__other__") voice = await ui.text("Voice name", "exactly as listed by `claude-voice voices`");
    }
  } else {
    voice = await ui.text("Voice id", "blank = provider default");
  }

  const cfg: Partial<VoiceConfig> = { ...existing, preset, provider };
  if (voice) cfg.voice = voice;
  else delete (cfg as Record<string, unknown>).voice;
  if (Object.keys(options).length) cfg.options = options;
  else delete (cfg as Record<string, unknown>).options;
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
  chmodSync(CONFIG_PATH, 0o600); // may hold an api_key

  const doInstall = await ui.confirm("Wire the hooks into ~/.claude/settings.json?", true);
  if (doInstall) {
    const s = ui.spinner("Wiring hooks");
    const where = install();
    s.stop(`Hooks wired ${ui.dim(`(${where})`)}`);
  } else {
    ui.step("Hooks", "skipped — run `claude-voice install` later");
  }

  if (await ui.confirm("Play a test phrase now?", true)) {
    detachChime("cli-test", "done");
    detachSpeak("cli-test", "Claude voice is ready.", loadConfig());
    ui.step("Test", "playing…");
  }

  ui.close();
  ui.outro([
    `${ui.bold("Next:")} restart Claude Code — hooks load at startup.`,
    `${ui.dim("Then give it a real task; short replies stay silent on purpose.")}`,
    "",
    `${ui.cyan("/claude-voice")} ${ui.dim("mute 1h · unmute · status   (inside Claude Code)")}`,
    `${ui.dim("config:")} ${CONFIG_PATH}`,
  ]);
}
