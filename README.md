# claude-voice

Give Claude Code a voice — **selective and tasteful, quiet by default.**

It speaks a one-sentence summary when a *substantial* task finishes, chimes when
Claude needs you, and otherwise stays silent. No "read every response aloud"
firehose: the point is to let you look away from the terminal, not to narrate it.

## Why another one?

Existing voice plugins either just play a sound, or read *everything* Claude
says (overwhelming). claude-voice is built around one idea: **say something only
when it's worth interrupting you.**

## Quick start

```bash
npx claude-voice init     # interactive: pick preset/provider/voice, wire hooks
```

Then **restart Claude Code**. Give it a real task (a few tool calls, ~15s+) and
you'll hear a spoken wrap-up when it finishes. That's it — the default uses your
OS's built-in TTS, so there are no API keys and no network calls.

`init` copies a small compiled runtime (~50 kB, no dependencies) to
`~/.claude/voice/app/` and points the hooks there — so hooks never touch npx,
the network, or your npm cache, and keep working across Node version switches.
Upgrading is `npx claude-voice@latest init`; removal is `npx claude-voice
uninstall`.

### Other ways to install

- **Claude Code plugin:** the repo ships a plugin manifest, so once it's on a
  marketplace you can `/plugin install` it instead — Claude Code then manages
  the hooks itself via `${CLAUDE_PLUGIN_ROOT}`. Use one mechanism or the other,
  not both.
- **From source:**

  ```bash
  git clone https://github.com/amenophis1er/claude-voice.git && cd claude-voice
  npm install && node src/cli.ts init   # runs the TS directly; needs Node ≥ 23.6
  ```

  Prefer make? `make init`, `make check`, `make say TEXT="hello"` wrap the same
  npm scripts.

## The one knob: `preset`

| preset | needs-you notification | task end | mid-task |
| --- | --- | --- | --- |
| `silent` | — | — | — |
| `chimes` | chime | chime | — |
| **`summary`** (default) | chime + spoken | spoken summary, *substantial tasks only* | — |
| `verbose` | chime + spoken | spoken summary, always | milestones *(roadmap)* |

Change it any time in `~/.claude/voice/config.json`, or rerun `init`.

## How it works

Four Claude Code hooks, one dispatcher (`src/dispatch.ts`):

- **`SessionStart`** injects a small instruction teaching Claude to end
  substantial tasks with **one natural, speakable closing sentence** — ordinary
  visible prose, no code, paths, or URLs.
- **`Stop`** takes the final assistant message (from the stable
  `last_assistant_message` hook field), sanitizes it (code, paths, URLs, and
  markdown noise are stripped), extracts the **ending** of the message, and
  speaks it. Because Claude wrote that sentence knowing it would be read aloud,
  it sounds like a person wrapping up — not a robot reading markdown. If Claude
  skips the instruction, the same extraction degrades gracefully to a cleaned,
  clamped tail of the message.
- **`Notification`** chimes and/or speaks a cue tailored to the type:
  permission prompt, idle, needs input, or complete.
- **`UserPromptSubmit`** instantly kills any audio still playing — the moment
  you start typing to Claude, it shuts up.

"Substantial" means the turn crossed a tool-call or duration threshold
(configurable, default 3 tool calls or 15 seconds), read best-effort from the
transcript. Trivial replies stay silent.

> **Design note:** earlier versions hid the summary in an HTML comment,
> assuming Claude Code's terminal renderer strips comments the way GitHub does.
> It doesn't — they print literally. The visible-closing-sentence approach
> replaced it; the comment form is still parsed for old sessions.

### Guardrails

Never speaks code/paths/URLs · summaries clamped to ~350 chars · repeat
summaries throttled (default 20s, per session) · per-session state so parallel
Claude sessions don't interrupt or throttle each other · optional quiet hours ·
optional **focus muting** (speak only when your terminal isn't frontmost,
macOS) · hooks are `async` + audio plays in a detached worker, so nothing ever
stalls your session.

## Providers

| id | quality | needs |
| --- | --- | --- |
| `system` (default) | fine | nothing — macOS `say`, Linux `espeak-ng`, Windows SAPI |
| `elevenlabs` | best | `ELEVENLABS_API_KEY` |
| `openai` | great | `OPENAI_API_KEY` |

If a cloud provider fails (no key, network down, timeout), playback falls back
to the system voice automatically — you still hear your summary.

Adding a provider is two steps: implement the `TtsProvider` interface in a new
file under `src/providers/`, register it in `src/providers/registry.ts`.

## Configuration

`~/.claude/voice/config.json` — everything is optional; shown with defaults:

```json
{
  "preset": "summary",
  "provider": "system",
  "voice": null,
  "rate": 1,
  "options": {},
  "throttleSeconds": 20,
  "substantial": { "minToolCalls": 3, "minDurationSeconds": 15 },
  "speakOnlyWhenUnfocused": false,
  "quietHours": { "start": 22, "end": 8 }
}
```

| field | meaning |
| --- | --- |
| `preset` | The one knob — see table above. |
| `provider` | `system`, `elevenlabs`, or `openai`. |
| `voice` | Provider-specific voice name/id (`claude-voice voices` lists system ones). |
| `rate` | Speech speed, `1` = normal. |
| `options` | Free-form provider extras, e.g. `{ "model_id": "eleven_turbo_v2_5" }`. |
| `throttleSeconds` | Minimum gap between two spoken summaries in one session. |
| `substantial` | A task must clear **one** threshold to be summarized. |
| `speakOnlyWhenUnfocused` | Mute when a terminal is the frontmost app (macOS). |
| `quietHours` | 24h local time; wraps midnight (`22 → 8` means 10pm–8am). |

## CLI

```bash
node src/cli.ts init            # interactive setup (recommended)
node src/cli.ts install         # wire hooks into ~/.claude/settings.json
node src/cli.ts uninstall       # remove them (idempotent, leaves other hooks alone)
node src/cli.ts list            # list providers
node src/cli.ts voices          # list system voices
node src/cli.ts test "Hello"    # synthesize + play a phrase
node src/cli.ts config          # show active config + its path
```

## Requirements

- **Node ≥ 20** for the npx / plugin install (runs compiled JS). Running
  straight from a source checkout needs **Node ≥ 23.6** (executes the
  TypeScript directly via type stripping).
- **Playback:** macOS `afplay` (built in) / Linux `paplay` / Windows
  PowerShell. Chimes use macOS system sounds and are macOS-only for now.
- **Linux TTS:** `espeak-ng` (or `espeak`) for the `system` provider.

## Troubleshooting

- **Nothing is ever spoken** — restart Claude Code after installing; hooks load
  at startup. Then check `node src/cli.ts test "hello"` works at all.
- **Summaries only, no chimes on Linux/Windows** — expected; chimes are
  macOS-only for now.
- **Short tasks are silent** — by design. Lower `substantial.minToolCalls` /
  `minDurationSeconds` or set `preset: "verbose"` to speak everything.
- **Focus muting never mutes** — macOS asks for an Automation permission the
  first time `osascript` queries the frontmost app; if it's denied, claude-voice
  fails *open* (it speaks). Grant it in System Settings → Privacy → Automation.
- **Dig deeper** — `CLAUDE_VOICE_DEBUG=1` makes every hook append to
  `$TMPDIR/claude-voice-debug.log` with the reason something was (not) spoken:
  throttled, quiet hours, not substantial, provider fallback, playback errors.

## Development

```bash
npm run check     # typecheck + build + decision-logic tests
npm test          # just the tests (test/verify.mjs, no framework)
npm run build     # compile src/ → dist/ (plain JS, import paths rewritten)
```

`dist/` is committed on purpose: Claude Code plugin installs clone the repo and
have no build step, so the hooks point at the compiled files. CI fails if
`dist/` drifts from `src/` — run `npm run build` after changing source.

The interesting logic is deliberately pure and tested: sanitization, closing-
sentence extraction, clamping, preset policies, transcript stats. Audio I/O is
kept at the edges.

## License

MIT
