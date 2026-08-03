import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
import {
  acquirePlaybackLock,
  markSpoken,
  releasePlaybackLock,
  throttled,
} from "../src/speak.ts";
import { clearMilestone, nextMilestone } from "../src/milestone.ts";

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
  endSession("b"); // and ends
  assert.equal(shouldAnnounceProject({ announceProject: "auto" }, "a"), false);
} finally {
  delete process.env.CLAUDE_VOICE_SESSIONS_DIR;
  rmSync(announceDir, { recursive: true, force: true });
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

console.log("ALL ASSERTIONS PASSED");
