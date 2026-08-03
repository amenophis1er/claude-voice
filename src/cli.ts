#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname } from "node:path";
import { CONFIG_PATH, loadConfig, type Preset, type VoiceConfig } from "./config.ts";
import { listProviders } from "./providers/registry.ts";
import { install, listSystemVoices, uninstall } from "./install.ts";
import { detachChime, detachSpeak } from "./speak.ts";

const cmd = process.argv[2];

switch (cmd) {
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
      ].join("\n"),
    );
}

async function init(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, def: string): Promise<string> =>
    (await rl.question(`${q} [${def}]: `)).trim() || def;

  console.log("\nclaude-voice setup — press Enter to accept the default.\n");

  const PRESETS: Preset[] = ["silent", "chimes", "summary", "verbose"];
  const presetIn = await ask("Verbosity: silent | chimes | summary | verbose", "summary");
  const preset: Preset = (PRESETS as string[]).includes(presetIn) ? (presetIn as Preset) : "summary";
  if (preset !== presetIn) console.log(`  (unknown preset "${presetIn}" — using "summary")`);

  console.log("\nProviders:");
  for (const p of listProviders()) {
    console.log(`  ${p.id}${p.zeroConfig ? " (no key)" : " (needs API key)"} — ${p.label}`);
  }
  const provider = await ask("\nProvider", "system");

  const voices = listSystemVoices();
  if (provider === "system" && voices.length) {
    console.log(`\n${voices.length} system voices (e.g. ${voices.slice(0, 6).join(", ")} …)`);
  }
  const voiceIn = await ask("Voice (blank = provider default)", "");

  const cfg: Partial<VoiceConfig> = { preset, provider };
  if (voiceIn) cfg.voice = voiceIn;

  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`\nWrote ${CONFIG_PATH}`);

  const doInstall = (await ask("Install hooks into ~/.claude/settings.json now? (y/n)", "y")).toLowerCase();
  if (doInstall.startsWith("y")) console.log("Installed →", install());
  else console.log("Skipped. Run `claude-voice install` later.");

  const demo = (await ask("Play a test phrase? (y/n)", "y")).toLowerCase();
  rl.close();
  if (demo.startsWith("y")) {
    detachChime("cli-test", "done");
    detachSpeak("cli-test", "Claude voice is ready.", loadConfig());
  }
  console.log("\nDone. Restart Claude Code to load the hooks.");
}
