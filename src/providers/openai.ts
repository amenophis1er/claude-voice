import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveApiKey } from "./apikey.ts";
import type { SynthesizeInput, SynthesizeResult, TtsProvider } from "./types.ts";

const DEFAULT_VOICE = "nova";
const DEFAULT_MODEL = "gpt-4o-mini-tts";

/**
 * OpenAI TTS — good quality, single OPENAI_API_KEY. Opt-in upgrade.
 */
export const openAiProvider: TtsProvider = {
  id: "openai",
  label: "OpenAI TTS",
  zeroConfig: false,

  async synthesize(input: SynthesizeInput): Promise<SynthesizeResult> {
    const apiKey = resolveApiKey("OPENAI_API_KEY", input.options);
    if (!apiKey)
      throw new Error("no OpenAI key: set OPENAI_API_KEY, or api_key / apiKeyCommand in options");

    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: (input.options?.model as string) ?? DEFAULT_MODEL,
        voice: input.voice ?? DEFAULT_VOICE,
        input: input.text,
        response_format: "mp3",
        speed: input.rate ?? 1,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`OpenAI TTS ${res.status}: ${await res.text()}`);
    }
    const audioFile = join(input.outDir, `voice-${process.pid}-${counter++}.mp3`);
    await writeFile(audioFile, Buffer.from(await res.arrayBuffer()));
    return { audioFile };
  },
};

let counter = 0;
