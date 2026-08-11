import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_VOICE, isInstalled, synthesizeWav } from "../kokoro.ts";
import type { SynthesizeInput, SynthesizeResult, TtsProvider } from "./types.ts";

/**
 * Kokoro — local neural TTS. Free, offline, no API key; but it needs a
 * one-time `claude-voice kokoro install` (Python venv + ~350 MB of model),
 * so it is not zeroConfig: the safe fallback stays the system voice.
 *
 * Synthesis talks to the on-demand localhost server managed by kokoro.ts.
 * When not installed we throw a self-explanatory error — the dispatcher logs
 * it and falls back to the system voice, so audio never goes silent.
 */
export const kokoroProvider: TtsProvider = {
  id: "kokoro",
  label: "Kokoro (local neural TTS)",
  zeroConfig: false,

  async synthesize(input: SynthesizeInput): Promise<SynthesizeResult> {
    if (!isInstalled()) {
      throw new Error("Kokoro is not installed — run `claude-voice kokoro install`");
    }
    const wav = await synthesizeWav(input.text, {
      voice: input.voice ?? DEFAULT_VOICE,
      speed: input.rate ?? 1,
    });
    const audioFile = join(input.outDir, `voice-${process.pid}-${counter++}.wav`);
    await writeFile(audioFile, wav);
    return { audioFile };
  },

  /**
   * Sentence-by-sentence synthesis: local inference runs ~3× faster than the
   * audio it produces, so audio is audible after the first sentence (~0.5s)
   * while the rest synthesizes during playback.
   */
  async *synthesizeStream(input: SynthesizeInput): AsyncGenerator<SynthesizeResult> {
    if (!isInstalled()) {
      throw new Error("Kokoro is not installed — run `claude-voice kokoro install`");
    }
    for (const sentence of splitSentences(input.text)) {
      const wav = await synthesizeWav(sentence, {
        voice: input.voice ?? DEFAULT_VOICE,
        speed: input.rate ?? 1,
      });
      const audioFile = join(input.outDir, `voice-${process.pid}-${counter++}.wav`);
      await writeFile(audioFile, wav);
      yield { audioFile };
    }
  },
};

let counter = 0;

/**
 * Split prose into synthesis chunks at sentence ends. Fragments under
 * MIN_CHUNK chars merge forward — a chunk that's shorter than the model's
 * fixed per-call overhead would make playback choppier, not faster.
 */
const MIN_CHUNK = 25;

export function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?…])\s+/);
  const chunks: string[] = [];
  let pending = "";
  for (const part of parts) {
    pending = pending ? `${pending} ${part}` : part;
    if (pending.length >= MIN_CHUNK) {
      chunks.push(pending);
      pending = "";
    }
  }
  if (pending) {
    if (chunks.length) chunks[chunks.length - 1] += ` ${pending}`;
    else chunks.push(pending);
  }
  return chunks.filter((c) => c.trim());
}
