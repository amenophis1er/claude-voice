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
// NOT voice.md: /voice is a Claude Code built-in (voice input mode), and
// built-ins shadow user-level commands with no automatic prefixing.
const COMMAND_FILE = join(homedir(), ".claude", "commands", "claude-voice.md");

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
  ["PostToolUse", "milestone", true], // verbose preset's mid-task narration
  ["SessionEnd", "session-end", false], // sync: just unlinks the heartbeat file
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
  writeCommandFile(dirname(dispatch));
  return SETTINGS;
}

/**
 * /claude-voice slash command: mute, unmute, status — one file under
 * ~/.claude/commands. Plugin installs ship their own commands/claude-voice.md
 * instead, which Claude Code namespaces separately.
 */
function writeCommandFile(appDir: string): void {
  const cli = join(appDir, COMPILED ? "cli.js" : "cli.ts");
  mkdirSync(dirname(COMMAND_FILE), { recursive: true });
  writeFileSync(
    COMMAND_FILE,
    [
      "---",
      "description: Control claude-voice — stop, mute [30m|2h|1d], unmute, status",
      "---",
      "",
      `Run this via Bash: \`node "${cli}" $ARGUMENTS\``,
      "(no arguments → run `status`). Relay its one-line output back verbatim, nothing else.",
      "",
    ].join("\n"),
  );
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
  rmSync(COMMAND_FILE, { force: true });
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
