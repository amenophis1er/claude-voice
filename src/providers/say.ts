import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SynthesizeInput, SynthesizeResult, TtsProvider } from "./types.ts";

const execFileAsync = promisify(execFile);

/**
 * macOS built-in `say`. Zero config, offline, instant. The default so the
 * plugin works the moment it is installed, with no API key.
 */
export const sayProvider: TtsProvider = {
  id: "say",
  label: "macOS say (built-in)",
  zeroConfig: true,

  async synthesize(input: SynthesizeInput): Promise<SynthesizeResult> {
    const audioFile = join(input.outDir, `voice-${process.pid}-${counter++}.aiff`);
    const args = ["-o", audioFile];
    if (input.voice) args.push("-v", input.voice);
    // say uses words-per-minute; ~175 is normal. Scale by rate.
    if (input.rate && input.rate !== 1) {
      args.push("-r", String(Math.round(175 * input.rate)));
    }
    args.push(input.text);
    await execFileAsync("say", args);
    return { audioFile };
  },
};

let counter = 0;
