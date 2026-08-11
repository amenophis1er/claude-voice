import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_DIR } from "./install.ts";

/**
 * `claude-voice shortcut` — generate a macOS Shortcut that runs `recap`, ready
 * to hang off a global hotkey. A pre-built .shortcut can't be distributed: it
 * would bake in one machine's node and install paths, and macOS only imports
 * SIGNED shortcut files. So we generate the workflow with this machine's real
 * paths and sign it locally via the built-in `shortcuts` CLI.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
/** Running compiled (dist/, e.g. via npx) or straight from a source checkout? */
const COMPILED = import.meta.url.endsWith(".js");

function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The Shortcuts workflow plist: a single Run Shell Script action. */
export function buildShortcutPlist(command: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>WFWorkflowMinimumClientVersion</key><integer>900</integer>
  <key>WFWorkflowMinimumClientVersionString</key><string>900</string>
  <key>WFWorkflowClientVersion</key><string>2607.1.3</string>
  <key>WFWorkflowIcon</key>
  <dict>
    <key>WFWorkflowIconStartColor</key><integer>4274264319</integer>
    <key>WFWorkflowIconGlyphNumber</key><integer>59511</integer>
  </dict>
  <key>WFWorkflowImportQuestions</key><array/>
  <key>WFWorkflowInputContentItemClasses</key><array/>
  <key>WFWorkflowTypes</key><array/>
  <key>WFWorkflowActions</key>
  <array>
    <dict>
      <key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.runshellscript</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>Script</key><string>${escXml(command)}</string>
        <key>Shell</key><string>/bin/zsh</string>
        <key>InputMode</key><string>to stdin</string>
        <key>ShowOutput</key><false/>
      </dict>
    </dict>
  </array>
</dict>
</plist>
`;
}

/**
 * A CLI invocation with machine-local ABSOLUTE paths — Shortcuts runs
 * shell scripts with a bare PATH, so nothing may rely on lookup. Compiled
 * installs point at the vendored runtime (survives npx cache eviction and
 * node version switches), source checkouts at the checkout itself.
 */
function cliCommand(sub: string): string {
  const cli = COMPILED ? join(APP_DIR, "cli.js") : resolve(HERE, "cli.ts");
  if (COMPILED && !existsSync(cli)) {
    throw new Error("vendored runtime not found — run `claude-voice install` (or init) first");
  }
  return `"${nodePath()}" "${cli}" ${sub}`;
}

export function recapCommand(): string {
  return cliCommand("recap");
}

/**
 * A node path that survives upgrades: process.execPath resolves to Homebrew's
 * versioned Cellar directory, which `brew upgrade node` deletes. Prefer the
 * stable symlink when it points at the node we're running under.
 */
function nodePath(): string {
  for (const p of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
    try {
      if (realpathSync(p) === realpathSync(process.execPath)) return p;
    } catch {
      /* candidate not installed */
    }
  }
  return process.execPath;
}

/** The hotkey-worthy commands: hear a recap; silence a readout mid-word. */
const SHORTCUTS: Record<string, { sub: string; name: string }> = {
  recap: { sub: "recap", name: "Claude recap" },
  stop: { sub: "stop", name: "Claude voice stop" },
};

/** Generate, sign, and open the Shortcut import dialog. Returns the file path. */
export function createVoiceShortcut(kind = "recap"): string {
  const spec = SHORTCUTS[kind];
  if (!spec) throw new Error(`unknown shortcut "${kind}" — use: ${Object.keys(SHORTCUTS).join(", ")}`);
  if (platform() !== "darwin") {
    throw new Error(`Shortcuts is macOS-only — on Linux, bind \`claude-voice ${spec.sub}\` with your hotkey daemon (e.g. sxhkd).`);
  }
  const unsigned = join(tmpdir(), `claude-${kind}-unsigned.shortcut`);
  const signed = join(tmpdir(), `${spec.name}.shortcut`);
  writeFileSync(unsigned, buildShortcutPlist(cliCommand(spec.sub)));
  rmSync(signed, { force: true });
  execFileSync("shortcuts", ["sign", "-i", unsigned, "-o", signed, "-m", "people-who-know-me"]);
  rmSync(unsigned, { force: true });
  execFileSync("open", [signed]);
  return signed;
}
