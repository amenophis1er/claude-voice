import assert from "node:assert";
import {
  extractClosingSentence,
  extractVoiceMarker,
  sanitizeForSpeech,
  clampSpokenLength,
} from "../src/sanitize.ts";
import { parseDurationMs } from "../src/mute.ts";
import { readLastTurn } from "../src/transcript.ts";
import { policyFor } from "../src/config.ts";

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

// transcript stats: best-effort, 3 tool calls, ~45s
const fixture = new URL("./fixtures/transcript.jsonl", import.meta.url).pathname;
const t = readLastTurn(fixture);
assert.equal(t.toolCalls, 3);
assert.ok(t.durationSeconds >= 40, `dur=${t.durationSeconds}`);

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

console.log("ALL ASSERTIONS PASSED");
