#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, policyFor, type VoiceConfig } from "./config.ts";
import { chime, interrupt, speak } from "./speak.ts";
import { extractVoiceMarker, sanitizeForSpeech, clampSpokenLength } from "./sanitize.ts";
import { readLastTurn } from "./transcript.ts";

/**
 * Single entry point for every hook. Usage:
 *   node dispatch.ts <event>
 * where <event> is one of: stop | notification | prompt-submit | instructions
 * The hook's JSON payload arrives on stdin.
 */
const THROTTLE_FILE = join(tmpdir(), "claude-voice-last-spoken");

const INSTRUCTION = [
  "[claude-voice] When you finish a substantial task, end your final message with a",
  "one-sentence spoken summary wrapped in ⟨voice⟩...⟨/voice⟩ — natural, conversational,",
  "no code or file paths (it will be read aloud). Omit it for trivial replies.",
].join(" ");

async function main() {
  const event = process.argv[2];
  const payload = readStdinJson();
  const cfg = loadConfig();
  const policy = policyFor(cfg.preset);

  switch (event) {
    case "instructions":
      // Wired to SessionStart: inject the marker convention into context.
      emitAdditionalContext(INSTRUCTION);
      return;

    case "prompt-submit":
      interrupt(); // new prompt → cut any in-flight audio
      return;

    case "notification": {
      if (inQuietHours(cfg)) return;
      if (policy.chimeOnNotification) await chime("attention");
      if (policy.speakNotification) {
        const msg = typeof payload?.message === "string" ? payload.message : "Claude needs your input.";
        await speak(clampSpokenLength(sanitizeForSpeech(msg), 120), cfg);
      }
      return;
    }

    case "stop": {
      if (inQuietHours(cfg)) return;
      if (policy.chimeOnStop) await chime("done");
      if (!policy.speakSummary) return;

      const turn = payload?.transcript_path ? readLastTurn(payload.transcript_path) : undefined;
      if (!turn) return;

      const marker = extractVoiceMarker(turn.lastAssistantText);
      const substantial =
        turn.toolCalls >= cfg.substantial.minToolCalls ||
        turn.durationSeconds >= cfg.substantial.minDurationSeconds;

      // Speak only if: there's a marker, or preset says always, or it was substantial.
      if (!marker && !policy.speakAlways && !substantial) return;
      if (throttled(cfg)) return;

      const text =
        marker ??
        clampSpokenLength(sanitizeForSpeech(turn.lastAssistantText));
      if (!text) return;
      markSpoken();
      await speak(text, cfg);
      return;
    }

    default:
      process.stderr.write(`[claude-voice] unknown event: ${event}\n`);
  }
}

function readStdinJson(): any {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

function emitAdditionalContext(text: string): void {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }),
  );
}

function throttled(cfg: VoiceConfig): boolean {
  try {
    const last = Number(readFileSync(THROTTLE_FILE, "utf8"));
    return Date.now() - last < cfg.throttleSeconds * 1000;
  } catch {
    return false;
  }
}
function markSpoken(): void {
  writeFileSync(THROTTLE_FILE, String(Date.now()));
}

function inQuietHours(cfg: VoiceConfig): boolean {
  if (!cfg.quietHours) return false;
  const h = new Date().getHours();
  const { start, end } = cfg.quietHours;
  return start <= end ? h >= start && h < end : h >= start || h < end;
}

main().catch((err) => {
  process.stderr.write(`[claude-voice] ${err?.message ?? err}\n`);
});
