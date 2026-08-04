import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Latency + outcome metrics for the audio pipeline, one JSON line per record.
 * Answers "where does the time go?" — event emit vs TTS engine vs speaker
 * queue — and "why was nothing spoken?". Always on: appending a line costs
 * nothing, and the file rotates so it can never grow unbounded.
 */

export interface UtteranceRecord {
  t: "utterance";
  /** Emit time (hook dispatch) — worker start when the emit stamp is missing. */
  ts: number;
  /** Hook event (stop | notification | milestone) or CLI origin (test | recap). */
  event?: string;
  kind: "speak" | "chime";
  provider?: string;
  /** Primary provider failed; this record's timings are the fallback's. */
  fallback?: boolean;
  session: string;
  /** Dispatch → detached worker boot (node startup, ~100ms). */
  emitToWorkerMs?: number;
  /** TTS synthesis (the engine's latency). */
  synthMs?: number;
  /** Waiting for the machine-wide speaker lock (pure queueing delay). */
  queueWaitMs?: number;
  /** Audio duration (afplay run time). */
  playMs?: number;
  /** Emit → audible: the end-to-end number that matters. */
  totalMs?: number;
  outcome: "played" | "dropped-busy" | "no-audio" | "error";
}

export interface SkipRecord {
  t: "skip";
  ts: number;
  event: string;
  /** throttled | not-substantial | muted | quiet-hours | focus */
  reason: string;
}

export type MetricRecord = UtteranceRecord | SkipRecord;

const ROTATE_BYTES = 512 * 1024;

function metricsPath(): string {
  return (
    process.env.CLAUDE_VOICE_METRICS_FILE ?? // overridable for tests
    join(homedir(), ".claude", "voice", "metrics.jsonl")
  );
}

/** Append one record. Metrics must never break audio, so failures vanish. */
export function recordMetric(rec: MetricRecord): void {
  try {
    const path = metricsPath();
    mkdirSync(dirname(path), { recursive: true });
    try {
      if (statSync(path).size > ROTATE_BYTES) renameSync(path, `${path}.1`);
    } catch {
      /* no file yet */
    }
    appendFileSync(path, JSON.stringify(rec) + "\n");
  } catch {
    /* best effort */
  }
}

/** All records newer than `sinceMs` ago (rotated file included). */
export function readMetrics(sinceMs: number, nowMs = Date.now()): MetricRecord[] {
  const cutoff = nowMs - sinceMs;
  const out: MetricRecord[] = [];
  for (const path of [`${metricsPath()}.1`, metricsPath()]) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as MetricRecord;
        if (typeof rec.ts === "number" && rec.ts >= cutoff) out.push(rec);
      } catch {
        /* torn line at rotation — skip */
      }
    }
  }
  return out;
}

// ── Aggregation ──────────────────────────────────────────────────────────────

export function percentile(values: number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function p5095(values: number[]): string {
  return `p50 ${fmtMs(percentile(values, 50))}   p95 ${fmtMs(percentile(values, 95))}`;
}

/** Human report for `claude-voice stats`. Pure: records in, string out. */
export function formatStats(records: MetricRecord[], windowLabel: string): string {
  const utts = records.filter((r): r is UtteranceRecord => r.t === "utterance");
  const skips = records.filter((r): r is SkipRecord => r.t === "skip");
  if (!utts.length && !skips.length) {
    return `No metrics in the last ${windowLabel}. They accumulate as sessions speak.`;
  }

  const spoken = utts.filter((u) => u.kind === "speak");
  const played = spoken.filter((u) => u.outcome === "played");
  const lines: string[] = [];
  lines.push(
    `last ${windowLabel} — ${utts.length} utterance${utts.length === 1 ? "" : "s"}` +
      ` (${spoken.length} spoken, ${utts.length - spoken.length} chimes)`,
  );

  if (played.length) {
    const row = (indent: string, label: string, rest: string) =>
      lines.push(`${indent}${label.padEnd(22 - indent.length)}${rest}`);
    row("  ", "emit → audible", `${p5095(vals(played, "totalMs"))}   (n=${played.length})`);
    row("    ", "dispatch → worker", p5095(vals(played, "emitToWorkerMs")));
    for (const [provider, group] of byProvider(played)) {
      const fb = group.filter((u) => u.fallback).length;
      row(
        "    ",
        `synthesis ${provider}`,
        `${p5095(vals(group, "synthMs"))}   (n=${group.length}${fb ? `, ${fb} fallback` : ""})`,
      );
    }
    row("    ", "queue wait", p5095(vals(played, "queueWaitMs")));
  }

  const outcomes = count(utts.map((u) => u.outcome));
  lines.push(
    "  outcomes: " +
      ["played", "dropped-busy", "no-audio", "error"]
        .filter((o) => outcomes.get(o))
        .map((o) => `${outcomes.get(o)} ${o === "dropped-busy" ? "dropped (speaker busy)" : o}`)
        .join(" · "),
  );
  if (skips.length) {
    const reasons = count(skips.map((s) => s.reason));
    lines.push(
      "  skipped upstream: " +
        [...reasons.entries()].map(([r, n]) => `${n} ${r}`).join(" · "),
    );
  }
  return lines.join("\n");
}

function vals(utts: UtteranceRecord[], key: keyof UtteranceRecord): number[] {
  return utts.map((u) => u[key]).filter((v): v is number => typeof v === "number");
}

function byProvider(utts: UtteranceRecord[]): Map<string, UtteranceRecord[]> {
  const m = new Map<string, UtteranceRecord[]>();
  for (const u of utts) {
    if (u.synthMs === undefined) continue;
    const k = u.provider ?? "unknown";
    m.set(k, [...(m.get(k) ?? []), u]);
  }
  return m;
}

function count(keys: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}
