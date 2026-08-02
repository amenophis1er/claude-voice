import { elevenLabsProvider } from "./elevenlabs.ts";
import { openAiProvider } from "./openai.ts";
import { sayProvider } from "./say.ts";
import type { TtsProvider } from "./types.ts";

/**
 * The single place providers are registered. To add one: import it and add it
 * to this array. Everything else (config, CLI listing, fallback) reads from here.
 */
const PROVIDERS: TtsProvider[] = [sayProvider, elevenLabsProvider, openAiProvider];

const byId = new Map(PROVIDERS.map((p) => [p.id, p]));

export function getProvider(id: string): TtsProvider | undefined {
  return byId.get(id);
}

export function listProviders(): readonly TtsProvider[] {
  return PROVIDERS;
}

/** The zero-config fallback used when a chosen provider errors or is unset. */
export function defaultProvider(): TtsProvider {
  return PROVIDERS.find((p) => p.zeroConfig) ?? sayProvider;
}
