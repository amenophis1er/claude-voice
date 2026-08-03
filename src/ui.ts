import { createInterface } from "node:readline/promises";

/**
 * Minimal clack-style terminal UI — selects, confirms, spinner, banners —
 * hand-rolled so the package keeps zero runtime dependencies. Degrades to
 * plain numbered prompts when stdin/stdout isn't a TTY (piped, CI).
 */

const isTTY = Boolean(process.stdout.isTTY && process.stdin.isTTY);
const useColor = isTTY && !process.env.NO_COLOR;

const esc = (n: string, s: string): string => (useColor ? `\x1b[${n}m${s}\x1b[0m` : s);
export const dim = (s: string) => esc("2", s);
export const bold = (s: string) => esc("1", s);
export const cyan = (s: string) => esc("36", s);
export const green = (s: string) => esc("32", s);
export const yellow = (s: string) => esc("33", s);
export const magenta = (s: string) => esc("35", s);

const out = (s: string) => process.stdout.write(s);

/**
 * Non-TTY (piped) input needs its own buffering: readline emits every piped
 * line as soon as the chunk arrives, and lines emitted while no question()
 * listener is attached are dropped — later prompts then hang on a closed
 * stream. So we attach ONE line listener up front and queue everything;
 * prompts consume from the queue and EOF yields "" (accept defaults).
 */
let pipe: { queue: string[]; waiters: Array<(s: string) => void>; ended: boolean } | undefined;
function pipeSource(): NonNullable<typeof pipe> {
  if (pipe) return pipe;
  const p = { queue: [] as string[], waiters: [] as Array<(s: string) => void>, ended: false };
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (l) => {
    const w = p.waiters.shift();
    if (w) w(l);
    else p.queue.push(l);
  });
  rl.on("close", () => {
    p.ended = true;
    for (const w of p.waiters.splice(0)) w("");
  });
  return (pipe = p);
}
async function pipedAnswer(prompt: string): Promise<string> {
  const p = pipeSource();
  out(prompt);
  const line = p.queue.length ? p.queue.shift()! : p.ended ? "" : await new Promise<string>((r) => p.waiters.push(r));
  out(`${line}\n`);
  return line.trim();
}

/** No-op in TTY mode; releases piped stdin so the process can exit. */
export function close(): void {
  if (!isTTY) process.stdin.destroy();
}

export function intro(title: string, tagline: string): void {
  out(`\n${magenta("◆")} ${bold(title)} ${dim("·")} ${dim(tagline)}\n\n`);
}

export function outro(lines: string[]): void {
  out(`\n${lines.map((l) => `  ${l}`).join("\n")}\n\n`);
}

export function step(label: string, value: string): void {
  out(`${green("✓")} ${label} ${dim("·")} ${cyan(value)}\n`);
}

export interface SelectOption<T> {
  value: T;
  label: string;
  hint?: string;
}

/** Arrow-key single select; falls back to a numbered prompt without a TTY. */
export async function select<T>(label: string, options: SelectOption<T>[], initial = 0): Promise<T> {
  if (!isTTY) return selectFallback(label, options, initial);

  let index = initial;
  const render = (first: boolean): void => {
    if (!first) out(`\x1b[${options.length + 1}A`); // cursor up to re-render in place
    out(`\r\x1b[J${bold(label)}\n`);
    for (let i = 0; i < options.length; i++) {
      const o = options[i]!;
      const line = i === index ? `${cyan("❯")} ${bold(o.label)}` : `  ${o.label}`;
      out(`${line}${o.hint ? ` ${dim(o.hint)}` : ""}\n`);
    }
  };

  render(true);
  process.stdout.write("\x1b[?25l"); // hide cursor
  const answer = await new Promise<T>((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    const onKey = (buf: Buffer): void => {
      const k = buf.toString();
      if (k === "\x1b[A" || k === "k") index = (index - 1 + options.length) % options.length;
      else if (k === "\x1b[B" || k === "j" || k === "\t") index = (index + 1) % options.length;
      else if (k === "\r" || k === "\n") {
        stdin.off("data", onKey);
        stdin.setRawMode(false);
        stdin.pause();
        resolve(options[index]!.value);
        return;
      } else if (k === "\x03") cancel(); // ctrl-c
      render(false);
    };
    stdin.on("data", onKey);
  });
  out(`\x1b[${options.length + 1}A\r\x1b[J`); // collapse the menu
  process.stdout.write("\x1b[?25h");
  step(label, options.find((o) => o.value === answer)!.label);
  return answer;
}

async function selectFallback<T>(label: string, options: SelectOption<T>[], initial: number): Promise<T> {
  out(`${label}\n`);
  options.forEach((o, i) => out(`  ${i + 1}. ${o.label}${o.hint ? ` (${o.hint})` : ""}\n`));
  const raw = await pipedAnswer(`Choice [${initial + 1}]: `);
  const n = raw ? Number(raw) : initial + 1;
  return (options[n - 1] ?? options[initial]!).value;
}

export async function confirm(label: string, initial = true): Promise<boolean> {
  return select<boolean>(
    label,
    [
      { value: true, label: "Yes" },
      { value: false, label: "No" },
    ],
    initial ? 0 : 1,
  );
}

/** Free-text input with default; used where a fixed list can't work (voice ids). */
export async function text(
  label: string,
  placeholder: string,
  mask?: (shown: string) => string,
): Promise<string> {
  const prompt = `${bold(label)} ${dim(`(${placeholder})`)} `;
  let raw: string;
  if (isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    raw = (await rl.question(prompt)).trim();
    rl.close();
    // Rewind as many terminal rows as the prompt + typed input wrapped into,
    // else long inputs (URLs, pasted keys) leave duplicate ghost lines behind.
    const cols = process.stdout.columns || 80;
    const visible = prompt.replace(/\x1b\[[0-9;]*m/g, "").length + raw.length;
    const rows = Math.max(1, Math.ceil((visible + 1) / cols));
    out(`\x1b[${rows}A\r\x1b[J`);
    step(label, mask ? mask(raw || placeholder) : raw || placeholder);
  } else {
    raw = await pipedAnswer(prompt);
  }
  return raw;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinner(label: string): { stop: (msg: string) => void } {
  if (!isTTY) {
    out(`${label}…\n`);
    return { stop: (msg) => out(`${msg}\n`) };
  }
  let i = 0;
  out("\x1b[?25l");
  const timer = setInterval(() => out(`\r${cyan(FRAMES[i++ % FRAMES.length]!)} ${label}`), 80);
  return {
    stop(msg: string) {
      clearInterval(timer);
      out(`\r\x1b[J${green("✓")} ${msg}\n\x1b[?25h`);
    },
  };
}

export function cancel(): never {
  process.stdout.write(`\x1b[?25h\n${yellow("✖")} Setup cancelled — nothing was changed.\n`);
  process.exit(1);
}
