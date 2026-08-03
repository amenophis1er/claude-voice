/**
 * A TTS provider turns text into a playable audio file on disk.
 *
 * Adding a new provider is intentionally a two-step change:
 *   1. implement this interface in a new file under src/providers/
 *   2. register it in registry.ts
 *
 * Providers must NOT play audio themselves — they only synthesize to a file.
 * Playback + interruption is centralized in speak.ts so a single queue can
 * cut audio the instant the user submits a new prompt.
 */
export interface TtsProvider {
  /** Stable id used in config, e.g. "system", "elevenlabs", "openai". */
  readonly id: string;

  /** Human label for logs / CLI. */
  readonly label: string;

  /** True if it needs no API key / network — used to pick a safe default. */
  readonly zeroConfig: boolean;

  /**
   * Synthesize `text` to an audio file and return its absolute path.
   * `voice` and free-form `options` come from the user's config for this provider.
   * Throw on failure — the dispatcher will fall back to the zero-config provider.
   */
  synthesize(input: SynthesizeInput): Promise<SynthesizeResult>;
}

export interface SynthesizeInput {
  text: string;
  /** Provider-specific voice id/name, if the user set one. */
  voice?: string;
  /** Playback rate hint, 1 = normal. Providers map this as best they can. */
  rate?: number;
  /** Arbitrary provider-specific config (model_id, region, ...). */
  options?: Record<string, unknown>;
  /** Directory the provider should write its audio file into. */
  outDir: string;
}

export interface SynthesizeResult {
  /** Absolute path to a playable audio file (aiff/wav/mp3). */
  audioFile: string;
}
