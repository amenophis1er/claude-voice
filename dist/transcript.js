import { readFileSync, statSync } from "node:fs";
/** Transcripts grow unbounded; reading one synchronously on every hook event
 * costs the hook budget. Beyond this, skip the heuristic entirely — the
 * spoken text itself comes from last_assistant_message and is unaffected. */
const MAX_TRANSCRIPT_BYTES = 20 * 1024 * 1024;
/**
 * Best-effort read of the just-finished turn from a Claude Code transcript
 * (JSONL), used ONLY for the "was this substantial?" heuristic (tool count +
 * duration). The transcript's raw schema is internal to Claude Code and can
 * change between versions, so every caller must tolerate `undefined` and never
 * depend on this for correctness — the spoken text itself comes from the stable
 * `last_assistant_message` hook field, not from here.
 */
export function readLastTurn(transcriptPath, now = Date.now()) {
    let lines;
    try {
        if (statSync(transcriptPath).size > MAX_TRANSCRIPT_BYTES)
            return undefined;
        lines = readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean);
    }
    catch {
        return undefined;
    }
    const entries = lines.map(safeParse).filter(Boolean);
    // Find the boundary of the current turn: everything after the last HUMAN
    // message. Tool results also arrive as type:"user" entries in the transcript,
    // so a plain type check would clip the turn to the tail after the last tool
    // call and undercount everything.
    let start = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
        if (isHumanPrompt(entries[i])) {
            start = i + 1;
            break;
        }
    }
    const turn = entries.slice(start);
    let lastAssistantText = "";
    let lastAssistantTs;
    let toolCalls = 0;
    const stamps = [];
    for (const e of turn) {
        const t = Date.parse(e?.timestamp ?? "");
        if (!Number.isNaN(t))
            stamps.push(t);
        const content = e?.message?.content;
        if (!Array.isArray(content))
            continue;
        for (const block of content) {
            if (block?.type === "tool_use")
                toolCalls++;
            if (block?.type === "text" && e?.type === "assistant" && block.text) {
                lastAssistantText = block.text;
                if (!Number.isNaN(t))
                    lastAssistantTs = t;
            }
        }
    }
    // Measured to NOW, not to the last entry: hooks fire while the turn is
    // still live (PreToolUse arrives before a possibly-minutes-long tool runs),
    // and the question is "how long has this turn been going", not "how much
    // span do the recorded entries cover".
    const durationSeconds = stamps.length ? (now - Math.min(...stamps)) / 1000 : 0;
    return { lastAssistantText, lastAssistantTs, toolCalls, durationSeconds };
}
/** A type:"user" entry typed by the human, as opposed to a wrapped tool_result. */
function isHumanPrompt(e) {
    if (e?.type !== "user")
        return false;
    const c = e?.message?.content;
    if (typeof c === "string")
        return true;
    if (!Array.isArray(c))
        return false;
    return (c.some((b) => b?.type === "text") && !c.some((b) => b?.type === "tool_result"));
}
function safeParse(line) {
    try {
        return JSON.parse(line);
    }
    catch {
        return null;
    }
}
