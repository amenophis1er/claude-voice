import { execSync } from "node:child_process";

/**
 * Resolve a cloud provider's API key without forcing plaintext into config:
 *   1. the environment variable (classic)
 *   2. options.api_key — explicit value in config.json (plaintext; discouraged)
 *   3. options.apiKeyCommand — a shell command whose stdout is the key, e.g.
 *      "op read op://dev-env/ELEVENLABS_API_KEY/credential" (1Password),
 *      "security find-generic-password -w -s elevenlabs" (macOS keychain)
 * Hooks run outside your shell rc, so env vars set by on-demand loaders are
 * usually absent — apiKeyCommand is the reliable path for secret managers.
 */
export function resolveApiKey(envVar: string, options?: Record<string, unknown>): string | undefined {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;

  const explicit = options?.api_key;
  if (typeof explicit === "string" && explicit) return explicit;

  const cmd = options?.apiKeyCommand;
  if (typeof cmd === "string" && cmd) {
    try {
      return execSync(cmd, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
    } catch {
      return undefined; // command failed → caller reports the missing key
    }
  }
  return undefined;
}
