import { execFile } from "node:child_process";
import { platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SynthesizeInput, SynthesizeResult, TtsProvider } from "./types.ts";

const execFileAsync = promisify(execFile);

/**
 * Built-in OS text-to-speech. Zero config, offline, instant — the default so
 * the plugin works the moment it is installed with no API key. Picks the right
 * engine per platform so non-macOS degrades instead of breaking:
 *   macOS   → say -o file.aiff
 *   Linux   → espeak-ng -w file.wav   (or `espeak`)
 *   Windows → PowerShell System.Speech → file.wav
 */
export const systemProvider: TtsProvider = {
  id: "system",
  label: "OS built-in TTS (say / espeak / SAPI)",
  zeroConfig: true,

  async synthesize(input: SynthesizeInput): Promise<SynthesizeResult> {
    const os = platform();
    if (os === "darwin") return macSay(input);
    if (os === "win32") return winSapi(input);
    return linuxEspeak(input);
  },
};

async function macSay(input: SynthesizeInput): Promise<SynthesizeResult> {
  const audioFile = join(input.outDir, out("aiff"));
  const args = ["-o", audioFile];
  if (input.voice) args.push("-v", input.voice);
  if (input.rate && input.rate !== 1) args.push("-r", String(Math.round(175 * input.rate)));
  args.push(input.text);
  await execFileAsync("say", args);
  return { audioFile };
}

async function linuxEspeak(input: SynthesizeInput): Promise<SynthesizeResult> {
  const audioFile = join(input.outDir, out("wav"));
  const args = ["-w", audioFile];
  if (input.voice) args.push("-v", input.voice);
  if (input.rate && input.rate !== 1) args.push("-s", String(Math.round(175 * input.rate)));
  args.push(input.text);
  try {
    await execFileAsync("espeak-ng", args);
  } catch {
    await execFileAsync("espeak", args); // fall back to classic espeak
  }
  return { audioFile };
}

async function winSapi(input: SynthesizeInput): Promise<SynthesizeResult> {
  const audioFile = join(input.outDir, out("wav"));
  const rate = input.rate ? Math.round((input.rate - 1) * 10) : 0; // SAPI: -10..10
  // Text is passed via env to avoid PowerShell quoting pitfalls.
  const script =
    "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;" +
    `$s.Rate=${rate};` +
    (input.voice ? `$s.SelectVoice($env:CV_VOICE);` : "") +
    `$s.SetOutputToWaveFile($env:CV_OUT);$s.Speak($env:CV_TEXT);$s.Dispose();`;
  await execFileAsync("powershell", ["-NoProfile", "-Command", script], {
    env: { ...process.env, CV_OUT: audioFile, CV_TEXT: input.text, CV_VOICE: input.voice ?? "" },
  });
  return { audioFile };
}

let counter = 0;
function out(ext: string): string {
  return `voice-${process.pid}-${counter++}.${ext}`;
}
