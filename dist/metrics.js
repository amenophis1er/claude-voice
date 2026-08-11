import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
const ROTATE_BYTES = 512 * 1024;
function metricsPath() {
    return (process.env.CLAUDE_VOICE_METRICS_FILE ?? // overridable for tests
        join(homedir(), ".claude", "voice", "metrics.jsonl"));
}
/** Append one record. Metrics must never break audio, so failures vanish. */
export function recordMetric(rec) {
    try {
        const path = metricsPath();
        mkdirSync(dirname(path), { recursive: true });
        try {
            if (statSync(path).size > ROTATE_BYTES)
                renameSync(path, `${path}.1`);
        }
        catch {
            /* no file yet */
        }
        appendFileSync(path, JSON.stringify(rec) + "\n");
    }
    catch {
        /* best effort */
    }
}
/** All records newer than `sinceMs` ago (rotated file included). */
export function readMetrics(sinceMs, nowMs = Date.now()) {
    const cutoff = nowMs - sinceMs;
    const out = [];
    for (const path of [`${metricsPath()}.1`, metricsPath()]) {
        let raw;
        try {
            raw = readFileSync(path, "utf8");
        }
        catch {
            continue;
        }
        for (const line of raw.split("\n")) {
            if (!line.trim())
                continue;
            try {
                const rec = JSON.parse(line);
                if (typeof rec.ts === "number" && rec.ts >= cutoff)
                    out.push(rec);
            }
            catch {
                /* torn line at rotation — skip */
            }
        }
    }
    return out;
}
// ── Aggregation ──────────────────────────────────────────────────────────────
export function percentile(values, p) {
    if (!values.length)
        return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}
function fmtMs(ms) {
    if (ms === undefined)
        return "—";
    return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
function p5095(values) {
    return `p50 ${fmtMs(percentile(values, 50))}   p95 ${fmtMs(percentile(values, 95))}`;
}
/** Human report for `claude-voice stats`. Pure: records in, string out. */
export function formatStats(records, windowLabel) {
    const utts = records.filter((r) => r.t === "utterance");
    const skips = records.filter((r) => r.t === "skip");
    if (!utts.length && !skips.length) {
        return `No metrics in the last ${windowLabel}. They accumulate as sessions speak.`;
    }
    const spoken = utts.filter((u) => u.kind === "speak");
    const played = spoken.filter((u) => u.outcome === "played");
    const lines = [];
    lines.push(`last ${windowLabel} — ${utts.length} utterance${utts.length === 1 ? "" : "s"}` +
        ` (${spoken.length} spoken, ${utts.length - spoken.length} chimes)`);
    if (played.length) {
        const row = (indent, label, rest) => lines.push(`${indent}${label.padEnd(22 - indent.length)}${rest}`);
        row("  ", "emit → audible", `${p5095(vals(played, "totalMs"))}   (n=${played.length})`);
        row("    ", "dispatch → worker", p5095(vals(played, "emitToWorkerMs")));
        for (const [provider, group] of byProvider(played)) {
            const fb = group.filter((u) => u.fallback).length;
            row("    ", `synthesis ${provider}`, `${p5095(vals(group, "synthMs"))}   (n=${group.length}${fb ? `, ${fb} fallback` : ""})`);
        }
        row("    ", "queue wait", p5095(vals(played, "queueWaitMs")));
    }
    const outcomes = count(utts.map((u) => u.outcome));
    lines.push("  outcomes: " +
        ["played", "dropped-busy", "no-audio", "error"]
            .filter((o) => outcomes.get(o))
            .map((o) => `${outcomes.get(o)} ${o === "dropped-busy" ? "dropped (speaker busy)" : o}`)
            .join(" · "));
    if (skips.length) {
        const reasons = count(skips.map((s) => s.reason));
        lines.push("  skipped upstream: " +
            [...reasons.entries()].map(([r, n]) => `${n} ${r}`).join(" · "));
    }
    return lines.join("\n");
}
function vals(utts, key) {
    return utts.map((u) => u[key]).filter((v) => typeof v === "number");
}
function byProvider(utts) {
    const m = new Map();
    for (const u of utts) {
        if (u.synthMs === undefined)
            continue;
        const k = u.provider ?? "unknown";
        m.set(k, [...(m.get(k) ?? []), u]);
    }
    return m;
}
function count(keys) {
    const m = new Map();
    for (const k of keys)
        m.set(k, (m.get(k) ?? 0) + 1);
    return m;
}
