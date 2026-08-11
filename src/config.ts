import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Preset = "silent" | "chimes" | "summary" | "verbose";

/** Prefix spoken audio with the project (cwd) name. "auto" = only while other sessions are active. */
export type AnnounceProject = "always" | "auto" | "off";

/** How much of a finished reply is read aloud. "closing" = the closing
 * sentence only; "full" = the whole reply, sanitized (code/paths/URLs
 * stripped). Full pairs best with a local provider — free, streams
 * sentence-by-sentence, and a new prompt cuts it off instantly. */
export type SpeechDepth = "closing" | "full";

export interface VoiceConfig {
  /** One knob controls how much is spoken. Default: "summary". */
  preset: Preset;
  /** WHEN presets decide to speak a reply, HOW MUCH of it is read. */
  speech: SpeechDepth;
  provider: string;
  voice?: string;
  rate: number;
  /** Provider-specific extras (model_id, region, ...). */
  options: Record<string, unknown>;
  /** Min seconds between two spoken task-end summaries. */
  throttleSeconds: number;
  /** Min seconds between two spoken mid-task milestones (verbose preset). */
  milestoneIntervalSeconds: number;
  /** A task must clear one of these to count as "substantial" and be summarized. */
  substantial: { minToolCalls: number; minDurationSeconds: number };
  /** Optional quiet hours in 24h local time, e.g. { start: 22, end: 8 }. */
  quietHours?: { start: number; end: number };
  /** Only speak/chime when the terminal is NOT the focused app (macOS only). */
  speakOnlyWhenUnfocused: boolean;
  /** Say which project is talking, so parallel sessions are tellable apart. */
  announceProject: AnnounceProject;
}

const DEFAULTS: VoiceConfig = {
  preset: "summary",
  speech: "closing",
  provider: "system",
  rate: 1,
  options: {},
  throttleSeconds: 20,
  milestoneIntervalSeconds: 60,
  substantial: { minToolCalls: 3, minDurationSeconds: 15 },
  speakOnlyWhenUnfocused: false,
  announceProject: "auto",
};

export const CONFIG_PATH = join(homedir(), ".claude", "voice", "config.json");

export function loadConfig(): VoiceConfig {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<VoiceConfig>;
    return {
      ...DEFAULTS,
      ...raw,
      options: { ...DEFAULTS.options, ...(raw.options ?? {}) },
      substantial: { ...DEFAULTS.substantial, ...(raw.substantial ?? {}) },
    };
  } catch {
    return DEFAULTS; // no config file yet → sensible defaults
  }
}

/** What a given preset is allowed to do, resolved once so dispatch stays simple. */
export interface PresetPolicy {
  chimeOnNotification: boolean;
  chimeOnStop: boolean;
  speakNotification: boolean;
  speakSummary: boolean;
  /** Speak summaries even for trivial (non-substantial) tasks. */
  speakAlways: boolean;
  speakMilestones: boolean;
}

export function policyFor(preset: Preset): PresetPolicy {
  switch (preset) {
    case "silent":
      return blank();
    case "chimes":
      return { ...blank(), chimeOnNotification: true, chimeOnStop: true };
    case "summary":
      return {
        ...blank(),
        chimeOnNotification: true,
        speakNotification: true,
        speakSummary: true,
      };
    case "verbose":
      return {
        chimeOnNotification: true,
        chimeOnStop: false,
        speakNotification: true,
        speakSummary: true,
        speakAlways: true,
        speakMilestones: true,
      };
  }
}

function blank(): PresetPolicy {
  return {
    chimeOnNotification: false,
    chimeOnStop: false,
    speakNotification: false,
    speakSummary: false,
    speakAlways: false,
    speakMilestones: false,
  };
}
