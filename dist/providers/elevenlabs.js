import { writeFile } from "node:fs/promises";
import { join } from "node:path";
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
        const apiKey = process.env.ELEVENLABS_API_KEY;
        if (!apiKey)
            throw new Error("ELEVENLABS_API_KEY is not set");
        const voice = input.voice ?? DEFAULT_VOICE;
        const model = input.options?.model_id ?? DEFAULT_MODEL;
        const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
            method: "POST",
            headers: {
                "xi-api-key": apiKey,
                "content-type": "application/json",
                accept: "audio/mpeg",
            },
            body: JSON.stringify({ text: input.text, model_id: model }),
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
