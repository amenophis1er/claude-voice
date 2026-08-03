import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Running compiled (dist/, e.g. via npx) or straight from a source checkout? */
const COMPILED = import.meta.url.endsWith(".js");
/** Stable home for the vendored runtime — survives npx cache eviction and nvm switches. */
export const APP_DIR = join(homedir(), ".claude", "voice", "app");
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

/**
 * Where the hooks should point. Compiled (npx / npm install): vendor the whole
 * dist/ runtime into APP_DIR so the hook path stays valid forever, and run the
 * copied dispatch.js. Source checkout (dev): run dispatch.ts from the clone
 * directly (needs Node >= 23.6 for type stripping).
 */
function ensureDispatchPath(): string {
  if (!COMPILED) return resolve(HERE, "dispatch.ts");
  rmSync(APP_DIR, { recursive: true, force: true });
  cpSync(HERE, APP_DIR, { recursive: true });
  return join(APP_DIR, "dispatch.js");
}

/** Idempotently add our hooks to ~/.claude/settings.json. */
export function install(): string {
  const dispatch = ensureDispatchPath();
  const cmdFor = (sub: string): string => `node "${dispatch}" ${sub}`;
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

/** Remove our hooks from settings.json and the vendored runtime. */
export function uninstall(): string {
  const settings = readSettings();
  for (const event of Object.keys(settings.hooks ?? {})) {
    const groups = settings.hooks[event] as Array<{ hooks: HookCmd[] }>;
    stripOurs(groups);
    if (groups.length === 0) delete settings.hooks[event];
  }
  writeSettings(settings);
  rmSync(APP_DIR, { recursive: true, force: true }); // config.json is kept
  return SETTINGS;
}

/** Matches both dev (dispatch.ts) and vendored (dispatch.js) hook commands. */
function stripOurs(groups: Array<{ hooks: HookCmd[] }>): void {
  for (let i = groups.length - 1; i >= 0; i--) {
    const hooks = groups[i]?.hooks ?? [];
    if (hooks.some((h) => /dispatch\.(ts|js)/.test(h.command ?? ""))) groups.splice(i, 1);
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
