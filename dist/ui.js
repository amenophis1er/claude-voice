import { createInterface } from "node:readline/promises";
/**
 * Minimal clack-style terminal UI — selects, confirms, spinner, banners —
 * hand-rolled so the package keeps zero runtime dependencies. Degrades to
 * plain numbered prompts when stdin/stdout isn't a TTY (piped, CI).
 */
const isTTY = Boolean(process.stdout.isTTY && process.stdin.isTTY);
const useColor = isTTY && !process.env.NO_COLOR;
const esc = (n, s) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : s);
export const dim = (s) => esc("2", s);
export const bold = (s) => esc("1", s);
export const cyan = (s) => esc("36", s);
export const green = (s) => esc("32", s);
export const yellow = (s) => esc("33", s);
export const magenta = (s) => esc("35", s);
const out = (s) => process.stdout.write(s);
/**
 * Non-TTY (piped) input needs its own buffering: readline emits every piped
 * line as soon as the chunk arrives, and lines emitted while no question()
 * listener is attached are dropped — later prompts then hang on a closed
 * stream. So we attach ONE line listener up front and queue everything;
 * prompts consume from the queue and EOF yields "" (accept defaults).
 */
let pipe;
function pipeSource() {
    if (pipe)
        return pipe;
    const p = { queue: [], waiters: [], ended: false };
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (l) => {
        const w = p.waiters.shift();
        if (w)
            w(l);
        else
            p.queue.push(l);
    });
    rl.on("close", () => {
        p.ended = true;
        for (const w of p.waiters.splice(0))
            w("");
    });
    return (pipe = p);
}
async function pipedAnswer(prompt) {
    const p = pipeSource();
    out(prompt);
    const line = p.queue.length ? p.queue.shift() : p.ended ? "" : await new Promise((r) => p.waiters.push(r));
    out(`${line}\n`);
    return line.trim();
}
/** No-op in TTY mode; releases piped stdin so the process can exit. */
export function close() {
    if (!isTTY)
        process.stdin.destroy();
}
export function intro(title, tagline) {
    out(`\n${magenta("◆")} ${bold(title)} ${dim("·")} ${dim(tagline)}\n\n`);
}
export function outro(lines) {
    out(`\n${lines.map((l) => `  ${l}`).join("\n")}\n\n`);
}
export function step(label, value) {
    out(`${green("✓")} ${label} ${dim("·")} ${cyan(value)}\n`);
}
/**
 * Arrow-key single select; falls back to a numbered prompt without a TTY.
 * `onHighlight` fires on the initially focused option and on every move —
 * used by the kokoro voice picker to speak each voice as you land on it.
 * (TTY only: the numbered fallback can't track focus.)
 */
export async function select(label, options, initial = 0, onHighlight) {
    if (!isTTY)
        return selectFallback(label, options, initial);
    let index = initial;
    // Cursor-up by LOGICAL lines breaks the moment an option wraps: the count
    // comes up short, the stale question line survives above the menu, and every
    // keypress prints another ghost copy. Count terminal ROWS the way text()
    // does, and remember how many the last render actually used.
    let renderedRows = 0;
    const render = (first) => {
        if (!first)
            out(`\x1b[${renderedRows}A`); // cursor up to re-render in place
        out(`\r\x1b[J${bold(label)}\n`);
        renderedRows = terminalRows(label);
        for (let i = 0; i < options.length; i++) {
            const o = options[i];
            const line = i === index ? `${cyan("❯")} ${bold(o.label)}` : `  ${o.label}`;
            const full = `${line}${o.hint ? ` ${dim(o.hint)}` : ""}`;
            out(`${full}\n`);
            renderedRows += terminalRows(full);
        }
    };
    render(true);
    onHighlight?.(options[index].value);
    process.stdout.write("\x1b[?25l"); // hide cursor
    const answer = await new Promise((resolve) => {
        const stdin = process.stdin;
        stdin.setRawMode(true);
        stdin.resume();
        const onKey = (buf) => {
            const k = buf.toString();
            const before = index;
            if (k === "\x1b[A" || k === "k")
                index = (index - 1 + options.length) % options.length;
            else if (k === "\x1b[B" || k === "j" || k === "\t")
                index = (index + 1) % options.length;
            else if (k === "\r" || k === "\n") {
                stdin.off("data", onKey);
                stdin.setRawMode(false);
                stdin.pause();
                resolve(options[index].value);
                return;
            }
            else if (k === "\x03")
                cancel(); // ctrl-c
            if (index !== before)
                onHighlight?.(options[index].value);
            render(false);
        };
        stdin.on("data", onKey);
    });
    out(`\x1b[${renderedRows}A\r\x1b[J`); // collapse the menu
    process.stdout.write("\x1b[?25h");
    step(label, options.find((o) => o.value === answer).label);
    return answer;
}
/** How many terminal rows one printed line occupies once it wraps. */
export function terminalRows(line, cols = process.stdout.columns || 80) {
    const visible = line.replace(/\x1b\[[0-9;]*m/g, "").length;
    return Math.max(1, Math.ceil(visible / cols));
}
async function selectFallback(label, options, initial) {
    out(`${label}\n`);
    options.forEach((o, i) => out(`  ${i + 1}. ${o.label}${o.hint ? ` (${o.hint})` : ""}\n`));
    const raw = await pipedAnswer(`Choice [${initial + 1}]: `);
    const n = raw ? Number(raw) : initial + 1;
    return (options[n - 1] ?? options[initial]).value;
}
export async function confirm(label, initial = true) {
    return select(label, [
        { value: true, label: "Yes" },
        { value: false, label: "No" },
    ], initial ? 0 : 1);
}
/** Free-text input with default; used where a fixed list can't work (voice ids). */
export async function text(label, placeholder, mask) {
    const prompt = `${bold(label)} ${dim(`(${placeholder})`)} `;
    let raw;
    if (isTTY) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        raw = (await rl.question(prompt)).trim();
        rl.close();
        // Rewind as many terminal rows as the prompt + typed input wrapped into,
        // else long inputs (URLs, pasted keys) leave duplicate ghost lines behind.
        // (+1 column for the cursor sitting after the typed text.)
        out(`\x1b[${terminalRows(`${prompt}${raw} `)}A\r\x1b[J`);
        step(label, mask ? mask(raw || placeholder) : raw || placeholder);
    }
    else {
        raw = await pipedAnswer(prompt);
    }
    return raw;
}
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export function spinner(label) {
    if (!isTTY) {
        out(`${label}…\n`);
        return { stop: (msg) => out(`${msg}\n`) };
    }
    let i = 0;
    out("\x1b[?25l");
    const timer = setInterval(() => out(`\r${cyan(FRAMES[i++ % FRAMES.length])} ${label}`), 80);
    return {
        stop(msg) {
            clearInterval(timer);
            out(`\r\x1b[J${green("✓")} ${msg}\n\x1b[?25h`);
        },
    };
}
export function cancel() {
    process.stdout.write(`\x1b[?25h\n${yellow("✖")} Setup cancelled — nothing was changed.\n`);
    process.exit(1);
}
