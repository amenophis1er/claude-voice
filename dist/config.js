import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const DEFAULTS = {
    preset: "summary",
    provider: "system",
    rate: 1,
    options: {},
    throttleSeconds: 20,
    substantial: { minToolCalls: 3, minDurationSeconds: 15 },
    speakOnlyWhenUnfocused: false,
    announceProject: "auto",
};
export const CONFIG_PATH = join(homedir(), ".claude", "voice", "config.json");
export function loadConfig() {
    try {
        const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
        return {
            ...DEFAULTS,
            ...raw,
            options: { ...DEFAULTS.options, ...(raw.options ?? {}) },
            substantial: { ...DEFAULTS.substantial, ...(raw.substantial ?? {}) },
        };
    }
    catch {
        return DEFAULTS; // no config file yet → sensible defaults
    }
}
export function policyFor(preset) {
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
function blank() {
    return {
        chimeOnNotification: false,
        chimeOnStop: false,
        speakNotification: false,
        speakSummary: false,
        speakAlways: false,
        speakMilestones: false,
    };
}
