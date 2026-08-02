import assert from "node:assert";
import { extractVoiceMarker, sanitizeForSpeech, clampSpokenLength } from "../src/sanitize.ts";
import { readLastTurn } from "../src/transcript.ts";
import { policyFor } from "../src/config.ts";

// HTML-comment marker (hidden in rendered chat) is extracted...
assert.equal(
  extractVoiceMarker("Done.\n\n<!--voice: I split the parser and tests pass.-->"),
  "I split the parser and tests pass.",
);
// ...and the legacy angle-bracket form still parses
assert.equal(extractVoiceMarker("x ⟨voice⟩legacy⟨/voice⟩"), "legacy");
assert.equal(extractVoiceMarker("no marker here"), undefined);

// sanitize strips code/paths/urls/markdown AND html-comment markers
const s = sanitizeForSpeech(
  "Fixed `bug` in /Users/x/a.ts see https://y.com ```code```\n## Head **bold** <!--voice: hi-->",
);
assert.ok(!/`|\/Users|https:|##|\*\*|```|<!--/.test(s), `leaked: ${s}`);

// clamp caps length
assert.ok(clampSpokenLength("a. ".repeat(400)).length <= 350);

// transcript stats: best-effort, 3 tool calls, ~45s
const t = readLastTurn("/tmp/fake-transcript.jsonl");
assert.equal(t.toolCalls, 3);
assert.ok(t.durationSeconds >= 40, `dur=${t.durationSeconds}`);

// preset policies
assert.equal(policyFor("silent").speakSummary, false);
assert.equal(policyFor("summary").speakSummary, true);
assert.equal(policyFor("summary").speakAlways, false); // substantial-gated
assert.equal(policyFor("verbose").speakAlways, true); // always
assert.equal(policyFor("chimes").speakSummary, false);

console.log("ALL ASSERTIONS PASSED");
