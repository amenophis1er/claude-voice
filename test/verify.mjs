import assert from "node:assert";
import { extractVoiceMarker, sanitizeForSpeech, clampSpokenLength } from "../src/sanitize.ts";
import { readLastTurn } from "../src/transcript.ts";
import { policyFor } from "../src/config.ts";

// marker extraction
assert.equal(extractVoiceMarker("hi ⟨voice⟩spoken bit⟨/voice⟩ bye"), "spoken bit");
assert.equal(extractVoiceMarker("no marker here"), undefined);

// sanitize strips code/paths/urls/markdown
const s = sanitizeForSpeech("Fixed `bug` in /Users/x/a.ts see https://y.com ```code```\n## Head **bold**");
assert.ok(!/`|\/Users|https:|##|\*\*|```/.test(s), `leaked: ${s}`);

// clamp caps length
assert.ok(clampSpokenLength("a. ".repeat(400)).length <= 350);

// transcript stats: 3 tool calls, ~45s, marker present
const t = readLastTurn("/tmp/fake-transcript.jsonl");
assert.equal(t.toolCalls, 3);
assert.ok(t.durationSeconds >= 40, `dur=${t.durationSeconds}`);
assert.ok(extractVoiceMarker(t.lastAssistantText));

// preset policies
assert.deepEqual(policyFor("silent").speakSummary, false);
assert.equal(policyFor("summary").speakSummary, true);
assert.equal(policyFor("summary").speakAlways, false);   // substantial-gated
assert.equal(policyFor("verbose").speakAlways, true);     // always
assert.equal(policyFor("chimes").speakSummary, false);

console.log("ALL ASSERTIONS PASSED");
