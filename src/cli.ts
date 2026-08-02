#!/usr/bin/env node
import { CONFIG_PATH, loadConfig } from "./config.ts";
import { listProviders } from "./providers/registry.ts";
import { speak, chime } from "./speak.ts";

const cmd = process.argv[2];

switch (cmd) {
  case "list": {
    for (const p of listProviders()) {
      console.log(`${p.id.padEnd(12)} ${p.zeroConfig ? "•" : " "}  ${p.label}`);
    }
    console.log("\n• = zero-config (no API key needed)");
    break;
  }
  case "test": {
    const text = process.argv.slice(3).join(" ") || "Claude voice is working.";
    await chime("done");
    await speak(text, loadConfig());
    break;
  }
  case "config":
    console.log(CONFIG_PATH);
    console.log(JSON.stringify(loadConfig(), null, 2));
    break;
  default:
    console.log(
      [
        "claude-voice — give Claude Code a voice (quiet by default)",
        "",
        "  claude-voice list           list TTS providers",
        "  claude-voice test [text]     synthesize and play a phrase",
        "  claude-voice config          show active config + its path",
      ].join("\n"),
    );
}
