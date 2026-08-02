import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VoiceConfig } from "./config.ts";
import { defaultProvider, getProvider } from "./providers/registry.ts";

const OUT_DIR = mkdtempSync(join(tmpdir(), "claude-voice-"));
/** Where we record the currently-playing PID so a new prompt can cut it off. */
const PIDFILE = join(tmpdir(), "claude-voice-current.pid");

/**
 * Synthesize `text` with the configured provider (falling back to the
 * zero-config provider on any error) and play it, tracking the PID so
 * interrupt() can stop it the instant the user submits a new prompt.
 */
export async function speak(text: string, cfg: VoiceConfig): Promise<void> {
  if (!text.trim()) return;

  const chosen = getProvider(cfg.provider) ?? defaultProvider();
  let audioFile: string;
  try {
    ({ audioFile } = await chosen.synthesize({
      text,
      voice: cfg.voice,
      rate: cfg.rate,
      options: cfg.options,
      outDir: OUT_DIR,
    }));
  } catch (err) {
    const fallback = defaultProvider();
    if (fallback.id === chosen.id) throw err;
    ({ audioFile } = await fallback.synthesize({ text, outDir: OUT_DIR }));
  }

  await play(audioFile);
}

/** Play a short bundled/system chime — a non-verbal "look at me" cue. */
export async function chime(kind: "attention" | "done"): Promise<void> {
  const sound =
    kind === "attention"
      ? "/System/Library/Sounds/Ping.aiff"
      : "/System/Library/Sounds/Glass.aiff";
  await play(sound);
}

function play(audioFile: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("afplay", [audioFile], { stdio: "ignore" });
    writeFileSync(PIDFILE, String(child.pid));
    child.on("exit", resolve);
    child.on("error", () => resolve());
  });
}

/** Kill any in-flight playback. Called from the UserPromptSubmit hook. */
export function interrupt(): void {
  try {
    const pid = Number(readFileSync(PIDFILE, "utf8"));
    if (pid) process.kill(pid, "SIGTERM");
  } catch {
    // nothing playing
  }
}
