import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { clampSpokenLength, extractClosingSentence, sanitizeForSpeech } from "./sanitize.js";
/** Overridable for tests, which must not read the developer's real sessions. */
function projectsDir() {
    return process.env.CLAUDE_VOICE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
}
/** Most recently touched session transcript across all projects. */
export function latestTranscript(dir = projectsDir()) {
    let best;
    let bestMtime = -1;
    let projects;
    try {
        projects = readdirSync(dir);
    }
    catch {
        return undefined;
    }
    for (const proj of projects) {
        let files;
        try {
            files = readdirSync(join(dir, proj));
        }
        catch {
            continue; // stray non-directory entry
        }
        for (const f of files) {
            if (!f.endsWith(".jsonl"))
                continue;
            try {
                const m = statSync(join(dir, proj, f)).mtimeMs;
                if (m > bestMtime) {
                    bestMtime = m;
                    best = join(dir, proj, f);
                }
            }
            catch {
                /* skip */
            }
        }
    }
    return best;
}
/** Claude Code appends this hint to every recap; it's UI chrome, not content. */
const RECAP_SUFFIX = /\s*\(disable recaps in \/config\)\s*$/i;
export function extractRecap(transcriptPath) {
    let lines;
    try {
        lines = readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean);
    }
    catch {
        return undefined;
    }
    let away;
    const assistants = [];
    let cwd;
    for (const line of lines) {
        let e;
        try {
            e = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (typeof e?.cwd === "string")
            cwd = e.cwd;
        const ts = Date.parse(e?.timestamp ?? "") || 0;
        if (e?.type === "system" && e?.subtype === "away_summary" && typeof e?.content === "string") {
            away = { text: e.content.replace(RECAP_SUFFIX, ""), ts };
        }
        else if (e?.type === "assistant" && Array.isArray(e?.message?.content)) {
            for (const b of e.message.content) {
                if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
                    assistants.push({ text: b.text, ts });
                    if (assistants.length > 8)
                        assistants.shift(); // only the tail matters
                }
            }
        }
    }
    const lastAssistant = assistants[assistants.length - 1];
    const text = away && (!lastAssistant || away.ts >= lastAssistant.ts)
        ? clampSpokenLength(sanitizeForSpeech(away.text))
        : substantiveEnding(assistants);
    if (!text)
        return undefined;
    return { text, cwd, transcriptPath };
}
/**
 * The most recent assistant remark worth hearing. Mid-task, the very last text
 * block is often a one-line tool-call lead-in ("Need readFileSync in the test
 * imports:") that survives sanitizing as a stub — walk back to the closest
 * block whose extraction stands alone, keeping the newest as a last resort.
 */
function substantiveEnding(assistants) {
    let fallback = "";
    for (let i = assistants.length - 1; i >= 0; i--) {
        const ending = extractClosingSentence(assistants[i].text);
        if (ending.length >= 30 && !ending.endsWith(":"))
            return ending;
        fallback ||= ending;
    }
    return fallback;
}
