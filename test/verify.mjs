import assert from "node:assert";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractClosingSentence,
  extractVoiceMarker,
  sanitizeForSpeech,
  clampSpokenLength,
} from "../src/sanitize.ts";
import { parseDurationMs } from "../src/mute.ts";
import { readLastTurn } from "../src/transcript.ts";
import { policyFor } from "../src/config.ts";
import {
  endSession,
  projectName,
  shouldAnnounceProject,
  touchSession,
  withProjectPrefix,
} from "../src/announce.ts";
import { parseProcessTree } from "../src/tab.ts";
import {
  acquirePlaybackLock,
  markSpoken,
  releasePlaybackLock,
  throttled,
} from "../src/speak.ts";
import { clearMilestone, nextMilestone } from "../src/milestone.ts";
import { extractRecap, latestTranscript } from "../src/recap.ts";
import { formatStats, percentile, readMetrics, recordMetric } from "../src/metrics.ts";
import { buildShortcutPlist, recapCommand } from "../src/shortcut.ts";

// LEGACY: html-comment marker still parses for sessions on the old instruction
assert.equal(
  extractVoiceMarker("Done.\n\n<!--voice: I split the parser and tests pass.-->"),
  "I split the parser and tests pass.",
);
assert.equal(extractVoiceMarker("x ⟨voice⟩legacy⟨/voice⟩"), "legacy");
assert.equal(extractVoiceMarker("no marker here"), undefined);

// PRIMARY: closing sentence — speaks the END of the message, not the start
assert.equal(
  extractClosingSentence(
    "First I refactored the parser module.\n\nThen I fixed the tests.\n\n" +
      "Everything is refactored and all forty-two tests are passing now.",
  ),
  "Everything is refactored and all forty-two tests are passing now.",
);
// a too-short final sentence pulls in the previous one
assert.equal(
  extractClosingSentence("I rewrote the whole config loader and added tests. Done."),
  "I rewrote the whole config loader and added tests. Done.",
);
// code/paths/urls never reach the spoken text
const closing = extractClosingSentence(
  "Fixed it. See `loadConfig()` in /Users/x/config.ts and https://example.com for details on the new loader behavior.",
);
assert.ok(!/`|\/Users|https:/.test(closing), `leaked: ${closing}`);
// empty in → empty out
assert.equal(extractClosingSentence(""), "");
// clamped even if the last sentence is a monster
assert.ok(extractClosingSentence("word ".repeat(200) + "end.").length <= 350);

// sanitize strips code/paths/urls/markdown AND html-comment markers
const s = sanitizeForSpeech(
  "Fixed `bug` in /Users/x/a.ts see https://y.com ```code```\n## Head **bold** <!--voice: hi-->",
);
assert.ok(!/`|\/Users|https:|##|\*\*|```|<!--/.test(s), `leaked: ${s}`);

// clamp caps length
assert.ok(clampSpokenLength("a. ".repeat(400)).length <= 350);

// clamp never chops mid-word: sentence → clause → word-boundary fallbacks
// (regression: a 200-char milestone clamp once spoke "…an ask for you, flagged i")
const egress =
  "Egress IPs collected (66.175.209.123, 173.255.227.172, 45.79.137.174) — these need " +
  "allowlisting on Verascape staging before the full rehearsal can submit a real claim; " +
  "that's an ask for you, flagged in my wrap-up. Meanwhile the branch review is still running.";
const clamped = clampSpokenLength(sanitizeForSpeech(egress), 200);
assert.ok(clamped.endsWith("flagged in my wrap-up."), `bad cut: …${clamped.slice(-30)}`);
const noStops = clampSpokenLength("word ".repeat(100), 200);
assert.ok(noStops.length <= 200 && noStops.endsWith("word"), `mid-word: …${noStops.slice(-8)}`);
const clauseOnly = clampSpokenLength(("alpha beta gamma, ").repeat(30), 200);
assert.ok(/[a-z]$/.test(clauseOnly) && !clauseOnly.endsWith("gamm"), `mid-word: …${clauseOnly.slice(-8)}`);

// IPs never reach the spoken text, and don't leave "( , , )" husks behind
const ipClean = sanitizeForSpeech(egress);
assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(ipClean), `IP leaked: ${ipClean}`);
assert.ok(!/\(\s*[,;]/.test(ipClean), `punctuation husk: ${ipClean}`);

// transcript stats: best-effort, 3 tool calls, ~45s
const fixture = new URL("./fixtures/transcript.jsonl", import.meta.url).pathname;
const t = readLastTurn(fixture);
assert.equal(t.toolCalls, 3);
assert.ok(t.durationSeconds >= 40, `dur=${t.durationSeconds}`);
assert.ok(t.lastAssistantText.length > 0, "fixture has a final assistant remark");
assert.ok(t.lastAssistantTs > 0, "remark timestamp parsed — milestone freshness gate needs it");

// mute duration parsing
assert.equal(parseDurationMs("30m"), 30 * 60_000);
assert.equal(parseDurationMs("2h"), 2 * 3_600_000);
assert.equal(parseDurationMs("1d"), 86_400_000);
assert.equal(parseDurationMs(undefined), null); // indefinite
assert.throws(() => parseDurationMs("soon"));
assert.throws(() => parseDurationMs("10x"));

// preset policies
assert.equal(policyFor("silent").speakSummary, false);
assert.equal(policyFor("summary").speakSummary, true);
assert.equal(policyFor("summary").speakAlways, false); // substantial-gated
assert.equal(policyFor("verbose").speakAlways, true); // always
assert.equal(policyFor("chimes").speakSummary, false);

// project announcement: name derivation is speakable
assert.equal(projectName("/Users/x/Projects/claude-voice"), "claude voice");
assert.equal(projectName("/srv/my_app.v2"), "my app v2");
assert.equal(projectName(undefined), undefined);
assert.equal(projectName(""), undefined);
assert.equal(withProjectPrefix("Task complete.", "claude voice"), "claude voice: Task complete.");
assert.equal(withProjectPrefix("Task complete.", undefined), "Task complete.");

// announce policy: always/off are unconditional, auto needs ANOTHER live session
const announceDir = join(tmpdir(), `claude-voice-test-sessions-${process.pid}`);
process.env.CLAUDE_VOICE_SESSIONS_DIR = announceDir;
try {
  assert.equal(shouldAnnounceProject({ announceProject: "always" }, "a"), true);
  assert.equal(shouldAnnounceProject({ announceProject: "off" }, "a"), false);
  assert.equal(shouldAnnounceProject({ announceProject: "auto" }, "a"), false); // alone
  touchSession("a"); // my own heartbeat doesn't count
  assert.equal(shouldAnnounceProject({ announceProject: "auto" }, "a"), false);
  touchSession("b"); // a second session appears
  assert.equal(shouldAnnounceProject({ announceProject: "auto" }, "a"), true);
  // …but if the user is looking straight at session a's tab, the prefix is noise
  const lookingAtMe = () => true;
  assert.equal(shouldAnnounceProject({ announceProject: "auto" }, "a", lookingAtMe), false);
  // and any uncertainty (can't detect the tab) keeps the prefix — fail open
  const cantTell = () => undefined;
  assert.equal(shouldAnnounceProject({ announceProject: "auto" }, "a", cantTell), true);
  endSession("b"); // and ends
  assert.equal(shouldAnnounceProject({ announceProject: "auto" }, "a"), false);
} finally {
  delete process.env.CLAUDE_VOICE_SESSIONS_DIR;
  rmSync(announceDir, { recursive: true, force: true });
}

// ── tab.ts: process-tree parsing ─────────────────────────────────────────────
{
  // Terminal.app: executable name == scriptable app name
  const terminalPs = [
    "  PID  PPID TTY      COMM",
    "    1     0 ??       /sbin/launchd",
    " 2998     1 ??       /Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
    "39264  2998 ttys014  /usr/bin/login",
    "39266 39264 ttys014  -zsh",
    "52542 39266 ttys014  claude",
  ].join("\n");
  assert.deepEqual(parseProcessTree(terminalPs, 52542), { tty: "ttys014", app: "Terminal" });

  // iTerm2: bundle is iTerm.app but the binary is iTerm2 — matched via exe name
  const itermPs = [
    "  PID  PPID TTY      COMM",
    "    1     0 ??       /sbin/launchd",
    " 2998     1 ??       /Applications/iTerm.app/Contents/MacOS/iTerm2",
    "39264  2998 ttys014  /usr/bin/login",
    "52542 39264 ttys014  claude",
  ].join("\n");
  assert.deepEqual(parseProcessTree(itermPs, 52542), { tty: "ttys014", app: "iTerm2" });

  // VS Code integrated terminal: scriptable? No AppleScript tty bridge →
  // undefined (fail open), so the prefix is never wrongly suppressed.
  const vscodePs = terminalPs
    .replace("Utilities/Terminal", "Visual Studio Code")
    .replace("MacOS/Terminal", "MacOS/Code");
  assert.equal(parseProcessTree(vscodePs, 52542), undefined);

  // No tty in the chain (e.g. launched from a non-terminal wrapper) — undefined.
  const noTtyPs = "    1     0 ??       /sbin/launchd\n  100     1 ??       node";
  assert.equal(parseProcessTree(noTtyPs, 100), undefined);

  // An unrelated daemon's tree must not leak into the walk.
  const ghostPs = [
    "  PID  PPID TTY      COMM",
    "    1     0 ??       /sbin/launchd",
    " 2998     1 ??       /Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
    "39264  2998 ttys014  /usr/bin/login",
    "52542 39264 ttys020  claude", // tty differs from the tab's — still the tab's tty
  ].join("\n");
  // first ancestor with a real tty is the tab owner; our own ttys020 is kept
  assert.equal(parseProcessTree(ghostPs, 52542)?.tty, "ttys020");
}

// idle grace: a fresh spoken summary suppresses the idle nudge (dispatch reuses
// throttled() for this), other sessions and expired windows don't
const idleSession = `verify-idle-${process.pid}`;
try {
  assert.equal(throttled(idleSession, 600), false); // nothing spoken yet
  markSpoken(idleSession);
  assert.equal(throttled(idleSession, 600), true); // summary just spoke → suppress
  assert.equal(throttled(idleSession, 0), false); // window elapsed → nudge again
  assert.equal(throttled(`${idleSession}-other`, 600), false); // per-session
} finally {
  rmSync(join(tmpdir(), `claude-voice-${idleSession}.last`), { force: true });
}

// milestones: interval pacing, no-repeat, sanitized, reset at turn boundary
const ms = `verify-milestone-${process.pid}`;
try {
  const t0 = 1_000_000_000_000;
  assert.equal(nextMilestone(ms, "Now migrating the parser.", 60, t0), "Now migrating the parser.");
  assert.equal(nextMilestone(ms, "Another remark.", 60, t0 + 30_000), undefined); // too soon
  assert.equal(nextMilestone(ms, "Now migrating the parser.", 60, t0 + 90_000), undefined); // repeat
  assert.equal(nextMilestone(ms, "Tests green, cleaning up.", 60, t0 + 90_000), "Tests green, cleaning up.");
  assert.equal(nextMilestone(ms, "```only code```", 60, t0 + 999_000), undefined); // nothing speakable
  clearMilestone(ms); // new turn → same remark may speak again immediately
  assert.equal(nextMilestone(ms, "Tests green, cleaning up.", 60, t0 + 999_000), "Tests green, cleaning up.");
} finally {
  clearMilestone(ms);
}

// playback lock: exclusive, waits (fails open) while held, steals from the dead
const lockDir = join(tmpdir(), `claude-voice-test-lock-${process.pid}`);
mkdirSync(lockDir, { recursive: true });
process.env.CLAUDE_VOICE_LOCK_DIR = lockDir;
try {
  assert.equal(await acquirePlaybackLock(500), true); // free → claimed
  assert.equal(await acquirePlaybackLock(400), false); // held (by us, alive) → timeout
  releasePlaybackLock();
  assert.equal(await acquirePlaybackLock(500), true); // released → claimable again
  releasePlaybackLock();
  writeFileSync(join(lockDir, "claude-voice-playback.lock"), "999999999"); // dead holder
  assert.equal(await acquirePlaybackLock(2000), true); // stolen
  releasePlaybackLock();
} finally {
  delete process.env.CLAUDE_VOICE_LOCK_DIR;
  rmSync(lockDir, { recursive: true, force: true });
}

// recap: away_summary wins while newest; a later assistant message supersedes it
const recapDir = join(tmpdir(), `claude-voice-test-recap-${process.pid}`);
mkdirSync(join(recapDir, "-Users-x-proj"), { recursive: true });
const entry = (o) => JSON.stringify(o) + "\n";
const older = join(recapDir, "-Users-x-proj", "old.jsonl");
const newer = join(recapDir, "-Users-x-proj", "new.jsonl");
try {
  writeFileSync(
    older,
    entry({ type: "assistant", timestamp: "2026-08-03T10:00:00Z", cwd: "/Users/x/old-proj",
      message: { content: [{ type: "text", text: "Old session. All old work is finished." }] } }),
  );
  writeFileSync(
    newer,
    entry({ type: "assistant", timestamp: "2026-08-03T11:00:00Z", cwd: "/Users/x/proj",
      message: { content: [{ type: "text", text: "Deployed. The staging rollout is complete and healthy." }] } }) +
    entry({ type: "system", subtype: "away_summary", timestamp: "2026-08-03T11:05:00Z",
      content: "You asked me to roll out staging; done. Next: production. (disable recaps in /config)" }),
  );
  assert.equal(latestTranscript(recapDir), newer); // written after `older` → newest mtime
  // recap entry is newest → spoken, chrome suffix stripped, cwd carried
  let r = extractRecap(newer);
  assert.equal(r.text, "You asked me to roll out staging; done. Next: production.");
  assert.equal(r.cwd, "/Users/x/proj");
  // session moves past the recap → the newer assistant ending wins instead
  writeFileSync(
    newer,
    readFileSync(newer, "utf8") +
      entry({ type: "assistant", timestamp: "2026-08-03T11:10:00Z", cwd: "/Users/x/proj",
        message: { content: [{ type: "text", text: "Actually production is now rolled out too, all green." }] } }),
  );
  r = extractRecap(newer);
  assert.equal(r.text, "Actually production is now rolled out too, all green.");
  // a trailing tool-call lead-in ("Now the wiring:") is skipped for the last
  // substantive remark
  writeFileSync(
    newer,
    readFileSync(newer, "utf8") +
      entry({ type: "assistant", timestamp: "2026-08-03T11:11:00Z",
        message: { content: [{ type: "text", text: "Now the `wiring`:" }] } }),
  );
  assert.equal(extractRecap(newer).text, "Actually production is now rolled out too, all green.");
  // no speakable content at all → undefined
  writeFileSync(older, entry({ type: "user", message: { content: "hi" } }));
  assert.equal(extractRecap(older), undefined);
} finally {
  rmSync(recapDir, { recursive: true, force: true });
}

// shortcut generator: absolute machine-local paths, XML-safe embedding
const rc = recapCommand();
assert.ok(/^"\/[^"]*node"/.test(rc), rc); // node by absolute path (stable symlink preferred)
assert.ok(rc.endsWith('cli.ts" recap'), rc); // source checkout → the checkout's cli
const plist = buildShortcutPlist('run "x" & <y>');
assert.ok(plist.includes("is.workflow.actions.runshellscript"));
assert.ok(plist.includes("&amp; &lt;y&gt;"), "special chars must be XML-escaped");
assert.ok(!plist.includes("& <y>"), "unescaped command leaked into plist");

// metrics: record → read round-trip, window filter, percentiles, report shape
const metricsDir = join(tmpdir(), `claude-voice-test-metrics-${process.pid}`);
mkdirSync(metricsDir, { recursive: true });
process.env.CLAUDE_VOICE_METRICS_FILE = join(metricsDir, "metrics.jsonl");
try {
  const t0 = 1_700_000_000_000;
  recordMetric({ t: "utterance", ts: t0, event: "stop", kind: "speak", session: "s",
    provider: "openai", emitToWorkerMs: 120, synthMs: 1400, queueWaitMs: 0, playMs: 2500,
    totalMs: 1600, outcome: "played" });
  recordMetric({ t: "utterance", ts: t0 + 1000, event: "milestone", kind: "speak", session: "s",
    provider: "openai", synthMs: 900, queueWaitMs: 3000, outcome: "dropped-busy" });
  recordMetric({ t: "utterance", ts: t0 + 2000, event: "stop", kind: "chime", session: "s",
    provider: "chime", queueWaitMs: 10, playMs: 400, outcome: "played" });
  recordMetric({ t: "skip", ts: t0 + 3000, event: "stop", reason: "throttled" });
  recordMetric({ t: "skip", ts: t0 - 999_999_999, event: "stop", reason: "muted" }); // outside window

  const recs = readMetrics(3_600_000, t0 + 10_000); // 1h window
  assert.equal(recs.length, 4, "old record filtered out");
  assert.equal(recs.filter((r) => r.t === "skip").length, 1);

  assert.equal(percentile([], 50), undefined);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);

  const report = formatStats(recs, "24h");
  assert.ok(report.includes("3 utterances (2 spoken, 1 chimes)"), report);
  assert.ok(report.includes("synthesis openai"), report);
  assert.ok(report.includes("1 dropped (speaker busy)"), report);
  assert.ok(report.includes("1 throttled"), report);
  assert.ok(/emit → audible\s+p50 1\.6s/.test(report), report);
  // empty window → friendly message, not a zero-filled table
  assert.ok(formatStats([], "24h").includes("No metrics"), "empty-state message");
} finally {
  delete process.env.CLAUDE_VOICE_METRICS_FILE;
  rmSync(metricsDir, { recursive: true, force: true });
}

// ── kokoro: pure helpers ─────────────────────────────────────────────────────
{
  const { pythonVersionOk, formatBytes, SERVER_PY, MODEL_VARIANTS } = await import("../src/kokoro.ts");
  // onnxruntime wheel range: 3.10–3.13; too old, too new, and garbage all fail
  assert.ok(pythonVersionOk("Python 3.12.4"));
  assert.ok(pythonVersionOk("Python 3.10.0"));
  assert.ok(!pythonVersionOk("Python 3.9.18"));
  assert.ok(!pythonVersionOk("Python 3.14.0"));
  assert.ok(!pythonVersionOk("Python 2.7.18"));
  assert.ok(!pythonVersionOk("zsh: command not found"));

  assert.equal(formatBytes(88_000_000), "88 MB");
  assert.equal(formatBytes(1_500_000_000), "1.5 GB");
  assert.equal(formatBytes(512), "512 B");

  // the embedded server must keep serving the endpoints the provider calls
  assert.ok(SERVER_PY.includes('"/synth"'), "server handles /synth");
  assert.ok(SERVER_PY.includes('"/health"'), "server handles /health");
  // and must prefer whichever model the installer downloads
  for (const v of Object.values(MODEL_VARIANTS)) {
    assert.ok(SERVER_PY.includes(v.file), `server knows ${v.file}`);
  }
}

// ── speech: "full" — a whole markdown reply must sanitize into clean prose ───
{
  const reply = [
    "**What you'll feel:** the wait before the first word.",
    "",
    "- **Cold server.** It respawns in ~2 s. See `ensureServer()` in /Users/x/kokoro.ts.",
    "- Check https://example.com/docs for details.",
    "",
    "```bash",
    "claude-voice stats",
    "```",
    "",
    "So: use it for a day and let the stats settle.",
  ].join("\n");
  const full = clampSpokenLength(sanitizeForSpeech(reply), 4000);
  // everything speakable survives — start AND end, not just the closing line
  assert.ok(full.includes("the wait before the first word"), full);
  assert.ok(full.includes("use it for a day"), full);
  // nothing unspeakable leaks
  assert.ok(!/[`*#]|\/Users|https:|claude-voice stats/.test(full), `leaked: ${full}`);
  // defaults: existing configs without a speech field read as "closing"
  const { loadConfig: loadCfg } = await import("../src/config.ts");
  assert.ok(["closing", "full"].includes(loadCfg().speech));
}

// ── kokoro: sentence chunking for streamed synthesis ─────────────────────────
{
  const { splitSentences } = await import("../src/providers/kokoro.ts");
  // multi-sentence prose splits at sentence ends
  assert.deepEqual(
    splitSentences("The parser is refactored and tests pass. Coverage went up by three percent."),
    ["The parser is refactored and tests pass.", "Coverage went up by three percent."],
  );
  // tiny fragments merge forward instead of becoming choppy micro-chunks
  assert.deepEqual(
    splitSentences("Done. All forty-two tests are passing and the build is green."),
    ["Done. All forty-two tests are passing and the build is green."],
  );
  // a tiny trailing fragment merges backward
  assert.deepEqual(
    splitSentences("Everything is deployed and the dashboards look healthy. Nice."),
    ["Everything is deployed and the dashboards look healthy. Nice."],
  );
  // single sentence passes through untouched; empty stays empty
  assert.deepEqual(splitSentences("Claude voice is working."), ["Claude voice is working."]);
  assert.deepEqual(splitSentences(""), []);
}

console.log("ALL ASSERTIONS PASSED");
