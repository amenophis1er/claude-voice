#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { loadConfig, policyFor } from "./config.js";
import { mutedByFocus } from "./focus.js";
import { detachChime, detachSpeak, interrupt, logDebug, markSpoken, throttled, } from "./speak.js";
import { muted } from "./mute.js";
import { endSession, projectName, shouldAnnounceProject, touchSession, withProjectPrefix, } from "./announce.js";
import { clampSpokenLength, extractClosingSentence, extractVoiceMarker, sanitizeForSpeech } from "./sanitize.js";
import { readLastTurn } from "./transcript.js";
/**
 * Single entry point for every hook. Usage: `node dispatch.ts <event>`
 * where <event> is: stop | notification | prompt-submit | instructions | session-end
 * The hook's JSON payload arrives on stdin.
 */
const INSTRUCTION = [
    "[claude-voice] When you finish a substantial task, end your final message with a",
    "single short closing sentence that sums up what happened, written as normal",
    "visible prose. Keep it natural and conversational with no code, file paths, or",
    "URLs — it is read aloud verbatim. Skip it for trivial replies.",
].join(" ");
async function main() {
    const event = process.argv[2];
    const p = readStdinJson();
    const cfg = loadConfig();
    const policy = policyFor(cfg.preset);
    const session = typeof p.session_id === "string" ? p.session_id : "default";
    if (event === "session-end") {
        endSession(session);
        return;
    }
    // Heartbeat: lets announceProject "auto" see that parallel sessions exist.
    touchSession(session);
    switch (event) {
        case "instructions":
            emitAdditionalContext(INSTRUCTION); // SessionStart (synchronous)
            return;
        case "prompt-submit":
            interrupt(session); // new prompt → cut any in-flight audio
            return;
        case "notification": {
            if (silenced(cfg))
                return;
            if (policy.chimeOnNotification)
                detachChime(session, "attention");
            if (policy.speakNotification) {
                const phrase = notificationPhrase(p.notification_type, p.message);
                detachSpeak(session, spokenText(phrase, p.cwd, cfg, session), cfg);
            }
            return;
        }
        case "stop": {
            if (silenced(cfg))
                return;
            if (policy.chimeOnStop)
                detachChime(session, "done");
            if (!policy.speakSummary)
                return;
            const text = typeof p.last_assistant_message === "string" ? p.last_assistant_message : "";
            const marker = extractVoiceMarker(text); // legacy sessions only
            // Best-effort "was this substantial?" — never required for correctness.
            const stats = typeof p.transcript_path === "string" ? readLastTurn(p.transcript_path) : undefined;
            const substantial = stats
                ? stats.toolCalls >= cfg.substantial.minToolCalls ||
                    stats.durationSeconds >= cfg.substantial.minDurationSeconds
                : false;
            if (!marker && !policy.speakAlways && !substantial) {
                logDebug("stop: skipped (no marker, not substantial)");
                return;
            }
            if (throttled(session, cfg.throttleSeconds)) {
                logDebug("stop: skipped (throttled)");
                return;
            }
            // Claude is taught to end substantial tasks with a speakable closing
            // sentence, so the message's ending IS the summary.
            const spoken = marker ?? extractClosingSentence(text);
            if (!spoken)
                return;
            markSpoken(session);
            detachSpeak(session, spokenText(spoken, p.cwd, cfg, session), cfg);
            return;
        }
        default:
            process.stderr.write(`[claude-voice] unknown event: ${event}\n`);
    }
}
/** Prefix with the project name when config + session context say to. */
function spokenText(text, cwd, cfg, session) {
    return shouldAnnounceProject(cfg, session) ? withProjectPrefix(text, projectName(cwd)) : text;
}
/** Purposeful mute + quiet hours + focus muting, shared by stop/notification. */
function silenced(cfg) {
    if (muted()) {
        logDebug("silenced: muted on purpose");
        return true;
    }
    if (inQuietHours(cfg)) {
        logDebug("silenced: quiet hours");
        return true;
    }
    if (mutedByFocus(cfg)) {
        logDebug("silenced: terminal focused");
        return true;
    }
    return false;
}
/** Tailor the spoken phrase to the notification type when we recognize it. */
function notificationPhrase(type, message) {
    switch (type) {
        case "permission_prompt":
            return "Claude needs your permission.";
        case "idle_prompt":
            return "Claude is waiting for you.";
        case "agent_needs_input":
            return "Claude needs your input.";
        case "agent_completed":
            return "Task complete.";
        default:
            return typeof message === "string" && message.trim()
                ? clampSpokenLength(sanitizeForSpeech(message), 120)
                : "Claude needs your attention.";
    }
}
function readStdinJson() {
    try {
        return JSON.parse(readFileSync(0, "utf8"));
    }
    catch {
        return {};
    }
}
function emitAdditionalContext(text) {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
    }));
}
function inQuietHours(cfg) {
    if (!cfg.quietHours)
        return false;
    const h = new Date().getHours();
    const { start, end } = cfg.quietHours;
    return start <= end ? h >= start && h < end : h >= start || h < end;
}
main().catch((err) => {
    process.stderr.write(`[claude-voice] ${err?.message ?? err}\n`);
});
