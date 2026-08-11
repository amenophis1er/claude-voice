import { execFileSync } from "node:child_process";
import { platform } from "node:os";

/**
 * Active-tab detection for project announcement (macOS).
 *
 * Claude Code runs inside a terminal tab, and that tab owns one PTY. When a
 * spoken summary prefixes the project name ("claude voice: Task complete."),
 * the point is telling sessions apart — but if the user is LOOKING at that
 * exact tab right now, the prefix is noise. This module answers: "is this
 * session's tab the one currently selected in the frontmost terminal window?"
 *
 * Result semantics: true = definitely looking at it (suppress prefix),
 * false = definitely not (prefix), undefined = can't tell (fail open — prefix).
 * Anything unexpected (no tty, unsupported terminal, missing Automation
 * permission, tmux, ssh, Linux) degrades to undefined: keep today's behavior.
 */

/** Terminal apps with an AppleScript bridge from selected tab → tty. */
const SCRIPTABLE: Record<string, string> = {
  "Terminal": 'tell application "Terminal" to get tty of selected tab of front window',
  "iTerm2": 'tell application "iTerm2" to tell current session of current window to get tty',
};

export interface TabInfo {
  /** The session's controlling terminal, e.g. "ttys014". */
  tty: string;
  /** Process name of the terminal app, used to pick the AppleScript query. */
  app: string;
}

/**
 * Resolve the controlling tty and ancestor terminal app for a pid, once.
 * Walks the process tree from `pid` upward in a single `ps` call (no per-hop
 * spawns): the first ancestor with a real tty owns this session's tab; the
 * first ancestor that maps to a known terminal app tells us which query to
 * use later. Returns undefined when the chain can't be resolved (e.g. the
 * pid is already gone, or we're on a platform without ps).
 */
export function sessionTabInfo(pid: number): TabInfo | undefined {
  if (platform() !== "darwin") return undefined;
  let rows: string;
  try {
    rows = execFileSync("ps", ["-eo", "pid,ppid,tty,comm"], {
      encoding: "utf8",
      timeout: 1000,
    });
  } catch {
    return undefined;
  }
  return parseProcessTree(rows, pid);
}

/** True when this session's own tab is the selected one in the frontmost
 * window — i.e. the user is looking straight at the session, so a project
 * name prefix adds nothing. Requires both the tty map AND the AppleScript
 * round-trip to agree; any doubt → undefined (fail open: prefix).
 * Two osascript round-trips (~100ms total) are cached briefly so a burst of
 * hook events (PostToolUse, PostToolUse, ...) doesn't re-query each time. */
export function sessionTabFocused(info: TabInfo): boolean | undefined {
  const nowMs = Date.now();
  if (focusCache && nowMs - focusCache.at < FOCUS_CACHE_MS) return focusCache.value;
  const value = queryTabFocus(info);
  focusCache = { at: nowMs, value };
  return value;
}

const FOCUS_CACHE_MS = 2_000;
let focusCache: { at: number; value: boolean | undefined } | undefined;

function queryTabFocus(info: TabInfo): boolean | undefined {
  if (platform() !== "darwin") return undefined;
  const script = SCRIPTABLE[info.app];
  if (!script) return undefined; // terminal has no tty query bridge

  let frontApp: string;
  try {
    frontApp = execFileSync(
      "osascript",
      ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true'],
      { encoding: "utf8", timeout: 1000 },
    ).trim();
  } catch {
    return undefined; // Automation permission not granted
  }
  if (frontApp !== info.app) return false; // terminal isn't the frontmost app

  let selectedTty: string;
  try {
    selectedTty = execFileSync("osascript", ["-e", script], {
      encoding: "utf8",
      timeout: 1000,
    }).trim();
  } catch {
    return undefined; // query failed (window closed mid-check, etc.)
  }
  // AppleScript returns "/dev/ttys014"; ps reports "ttys014".
  return selectedTty.replace(/^\/dev\//, "") === info.tty;
}

// ── pure parsing (testable without a live process tree) ─────────────────────

/** Parse `ps -eo pid,ppid,tty,comm` output and resolve the tab for `pid`.
 * Exported for tests. */
export function parseProcessTree(psOutput: string, pid: number): TabInfo | undefined {
  const procs = new Map<number, { ppid: number; tty: string; comm: string }>();
  for (const line of psOutput.split("\n")) {
    // comm can contain spaces ("/Applications/Visual Studio Code.app/...")
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    procs.set(Number(m[1]), { ppid: Number(m[2]), tty: m[3]!, comm: m[4]!.trim() });
  }

  let cur = procs.get(pid);
  let tty: string | undefined;
  let app: string | undefined;
  for (let hops = 0; cur && hops < 32; hops++) {
    // First ancestor with a real tty owns the tab. "??" = no controlling tty.
    if (tty === undefined && cur.tty !== "??") tty = cur.tty;
    // The terminal app is an ancestor whose executable lives in a .app bundle
    // or is a well-known terminal binary name. Match on the executable's
    // basename first (iTerm.app's binary is "iTerm2"), then the bundle name.
    if (app === undefined) {
      const exeName = cur.comm.split("/").pop() ?? "";
      const bundleName = cur.comm.includes(".app/")
        ? cur.comm.split("/").find((s) => s.endsWith(".app"))?.slice(0, -".app".length)
        : undefined;
      const appName = SCRIPTABLE[exeName] !== undefined || TERMINAL_NAMES.has(exeName)
        ? exeName
        : bundleName;
      if (appName !== undefined && (SCRIPTABLE[appName] !== undefined || TERMINAL_NAMES.has(appName))) {
        app = appName;
      }
    }
    if (tty !== undefined && app !== undefined) break;
    cur = procs.get(cur.ppid);
  }
  if (tty === undefined || app === undefined) return undefined;
  return { tty, app };
}

/** Non-scriptable terminals we still want to recognize as "the app that owns
 * this session" — for diagnostics and future extensions. */
const TERMINAL_NAMES = new Set([
  "ghostty", "Ghostty", "wezterm-gui", "WezTerm", "alacritty", "Alacritty",
  "kitty", "Hyper", "Warp", "warp",
]);
