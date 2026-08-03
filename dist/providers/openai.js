import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveApiKey } from "./apikey.js";
const DEFAULT_VOICE = "nova";
const DEFAULT_MODEL = "gpt-4o-mini-tts";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
/**
 * OpenAI TTS — good quality, single OPENAI_API_KEY. Opt-in upgrade.
 *
 * Also speaks to any OpenAI-compatible endpoint (Kokoro, LocalAI, self-hosted)
 * via options.baseUrl. With a custom baseUrl the `model` field is only sent
 * when options.model is set — the server's default model is usually correct,
 * and OpenAI's model names would be rejected.
 */
export const openAiProvider = {
    id: "openai",
    label: "OpenAI TTS",
    zeroConfig: false,
    async synthesize(input) {
        const apiKey = resolveApiKey("OPENAI_API_KEY", input.options);
        if (!apiKey)
            throw new Error("no OpenAI key: set OPENAI_API_KEY, or api_key / apiKeyCommand in options");
        const baseUrl = (input.options?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
        const custom = baseUrl !== DEFAULT_BASE_URL;
        const model = input.options?.model ?? (custom ? undefined : DEFAULT_MODEL);
        const res = await fetch(`${baseUrl}/audio/speech`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${apiKey}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({
                ...(model ? { model } : {}),
                ...(input.voice || !custom ? { voice: input.voice ?? DEFAULT_VOICE } : {}),
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
