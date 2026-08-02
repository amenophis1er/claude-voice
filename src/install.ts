import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DISPATCH = resolve(HERE, "dispatch.ts");
const SETTINGS = join(homedir(), ".claude", "settings.json");

interface HookCmd {
  type: "command";
  command: string;
  async?: boolean;
  timeout?: number;
}

/** event → the dispatch subcommand + whether it must run async (non-blocking). */
const WIRING: Array<[string, string, boolean]> = [
  ["SessionStart", "instructions", false], // sync: stdout injects context
  ["UserPromptSubmit", "prompt-submit", false], // sync: fast interrupt
  ["Stop", "stop", true],
  ["Notification", "notification", true],
];

const cmdFor = (sub: string): string => `node "${DISPATCH}" ${sub}`;

/** Idempotently add our hooks to ~/.claude/settings.json. */
export function install(): string {
  const settings = readSettings();
  settings.hooks ??= {};
  for (const [event, sub, isAsync] of WIRING) {
    const groups = (settings.hooks[event] ??= []) as Array<{ hooks: HookCmd[] }>;
    // drop any prior claude-voice entry for this event, then add fresh
    stripOurs(groups);
    const hook: HookCmd = { type: "command", command: cmdFor(sub) };
    if (isAsync) {
      hook.async = true;
      hook.timeout = 30;
    }
    groups.push({ hooks: [hook] });
  }
  writeSettings(settings);
  return SETTINGS;
}

/** Remove our hooks from settings.json. */
export function uninstall(): string {
  const settings = readSettings();
  for (const event of Object.keys(settings.hooks ?? {})) {
    const groups = settings.hooks[event] as Array<{ hooks: HookCmd[] }>;
    stripOurs(groups);
    if (groups.length === 0) delete settings.hooks[event];
  }
  writeSettings(settings);
  return SETTINGS;
}

function stripOurs(groups: Array<{ hooks: HookCmd[] }>): void {
  for (let i = groups.length - 1; i >= 0; i--) {
    const hooks = groups[i]?.hooks ?? [];
    if (hooks.some((h) => h.command?.includes("dispatch.ts"))) groups.splice(i, 1);
  }
}

function readSettings(): any {
  try {
    return JSON.parse(readFileSync(SETTINGS, "utf8"));
  } catch {
    return {};
  }
}
function writeSettings(settings: unknown): void {
  mkdirSync(dirname(SETTINGS), { recursive: true });
  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
}

/** Available system-TTS voice names, best effort. */
export function listSystemVoices(): string[] {
  try {
    if (platform() === "darwin") {
      return execFileSync("say", ["-v", "?"], { encoding: "utf8" })
        .split("\n")
        .map((l) => l.split(/\s{2,}/)[0]?.trim())
        .filter((v): v is string => Boolean(v));
    }
  } catch {
    /* ignore */
  }
  return [];
}
