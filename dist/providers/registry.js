import { elevenLabsProvider } from "./elevenlabs.js";
import { openAiProvider } from "./openai.js";
import { systemProvider } from "./system.js";
/**
 * The single place providers are registered. To add one: import it and add it
 * to this array. Everything else (config, CLI listing, fallback) reads from here.
 */
const PROVIDERS = [systemProvider, elevenLabsProvider, openAiProvider];
const byId = new Map(PROVIDERS.map((p) => [p.id, p]));
export function getProvider(id) {
    return byId.get(id);
}
export function listProviders() {
    return PROVIDERS;
}
/** The zero-config fallback used when a chosen provider errors or is unset. */
export function defaultProvider() {
    return PROVIDERS.find((p) => p.zeroConfig) ?? systemProvider;
}
