import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveApiKey } from "./apikey.js";
const DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM"; // "Rachel"
const DEFAULT_MODEL = "eleven_turbo_v2_5";
/**
 * ElevenLabs — highest quality, needs ELEVENLABS_API_KEY. Opt-in upgrade.
 * Streams mp3 to a temp file; playback stays centralized in speak.ts.
 */
export const elevenLabsProvider = {
    id: "elevenlabs",
    label: "ElevenLabs",
    zeroConfig: false,
    async synthesize(input) {
        const apiKey = resolveApiKey("ELEVENLABS_API_KEY", input.options);
        if (!apiKey)
            throw new Error("no ElevenLabs key: set ELEVENLABS_API_KEY, or api_key / apiKeyCommand in options");
        const voice = input.voice ?? DEFAULT_VOICE;
        const model = input.options?.model_id ?? DEFAULT_MODEL;
        const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
            method: "POST",
            headers: {
                "xi-api-key": apiKey,
                "content-type": "application/json",
                accept: "audio/mpeg",
            },
            // ElevenLabs supports speed only via voice_settings, valid 0.7–1.2.
            body: JSON.stringify({
                text: input.text,
                model_id: model,
                ...(input.rate && input.rate !== 1
                    ? { voice_settings: { speed: Math.min(1.2, Math.max(0.7, input.rate)) } }
                    : {}),
            }),
            signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
            throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
        }
        const audioFile = join(input.outDir, `voice-${process.pid}-${counter++}.mp3`);
        await writeFile(audioFile, Buffer.from(await res.arrayBuffer()));
        return { audioFile };
    },
};
let counter = 0;
