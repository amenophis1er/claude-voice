import { execFileSync } from "node:child_process";
import { platform } from "node:os";
import type { VoiceConfig } from "./config.ts";

/** Apps we treat as "the terminal Claude Code is running in". */
const TERMINAL_APPS = new Set([
  "Terminal",
  "iTerm2",
  "Ghostty",
  "WezTerm",
  "Alacritty",
  "kitty",
  "Hyper",
  "Warp",
  "Code",
  "Cursor",
  "Electron", // VS Code / forks sometimes report this
]);

/**
 * Is a terminal the frontmost app right now? macOS only.
 * Returns undefined when we can't tell (non-macOS, missing permission, error) —
 * callers must fail OPEN (i.e. don't mute) on undefined.
 */
export function terminalFocused(): boolean | undefined {
  if (platform() !== "darwin") return undefined;
  try {
    const name = execFileSync(
      "osascript",
      ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true'],
      { encoding: "utf8", timeout: 1000 },
    ).trim();
    return TERMINAL_APPS.has(name);
  } catch {
    return undefined; // e.g. Automation permission not granted
  }
}

/** "notify me only when I'm not looking" — mute only if definitely focused. */
export function mutedByFocus(cfg: VoiceConfig): boolean {
  if (!cfg.speakOnlyWhenUnfocused) return false;
  return terminalFocused() === true;
}
