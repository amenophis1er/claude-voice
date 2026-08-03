# claude-voice

Give Claude Code a voice — **selective and tasteful, quiet by default.**

It speaks a one-sentence summary when a *substantial* task finishes, chimes when
Claude needs you, and otherwise stays silent. No "read every response aloud"
firehose: the point is to let you look away from the terminal, not to narrate it.

Existing voice plugins either just play a sound, or read *everything* Claude
says (overwhelming). claude-voice is built around one idea: **say something only
when it's worth interrupting you.**

## Install

### Option 1 — npx (recommended)

```bash
npx @amenophis1er/claude-voice init
```

The interactive setup lets you pick a verbosity preset, a voice, and a TTS
provider, then wires the hooks into `~/.claude/settings.json`. **Restart Claude
Code** afterwards and you're done.

Behind the scenes, `init` copies a small compiled runtime (~50 kB, zero
dependencies) to `~/.claude/voice/app/` and points the hooks at that stable
path — hooks never touch npx, the network, or your npm cache, and keep working
when you switch Node versions.

- **Upgrade:** `npx @amenophis1er/claude-voice@latest init`
- **Remove:** `npx @amenophis1er/claude-voice uninstall` (your config is kept)

### Option 2 — Claude Code plugin

Inside Claude Code:

```
/plugin marketplace add amenophis1er/claude-voice
/plugin install claude-voice@claude-voice
```

Claude Code manages the hooks itself and updates the plugin with the repo.
Use *either* the npx install *or* the plugin — not both, or you'll get double
audio.

### Requirements

- **Node ≥ 20** on your PATH (hooks run small compiled JS files)
- **Playback:** macOS works out of the box (`say` + `afplay`). Linux needs
  `espeak-ng` and `paplay`. Windows uses built-in PowerShell speech. Chimes are
  macOS-only for now.

## What you'll hear

One knob controls everything — the `preset`:

| preset | needs-you notification | task end | mid-task |
| --- | --- | --- | --- |
| `silent` | — | — | — |
| `chimes` | chime | chime | — |
| **`summary`** (default) | chime + spoken | spoken summary, *substantial tasks only* | — |
| `verbose` | chime + spoken | spoken summary, always | milestones *(roadmap)* |

"Substantial" means the task crossed a threshold (default: 3 tool calls or 15
seconds). Quick back-and-forth stays silent — that's the tasteful part.

The summary you hear isn't a robotic read-back: Claude is taught (via a session
instruction the hooks inject) to end real tasks with one natural, speakable
closing sentence — no code, paths, or URLs — and that's what gets spoken.

## Voices and providers

The default (`system`) uses your OS's built-in text-to-speech: zero config, no
API keys, works offline. Two opt-in upgrades:

| provider | quality | needs |
| --- | --- | --- |
| `system` (default) | fine | nothing |
| `elevenlabs` | best | `ELEVENLABS_API_KEY` in your environment |
| `openai` | great | `OPENAI_API_KEY` in your environment |

If a cloud provider fails (no key, network down, timeout), it falls back to the
system voice automatically — you still hear your summary.

**Keys from a secret manager:** hooks run outside your shell rc, so env vars
set by on-demand loaders are often absent. Instead of exporting keys globally,
give the provider a command that prints the key:

```json
{
  "provider": "elevenlabs",
  "options": { "apiKeyCommand": "op read op://dev-env/ELEVENLABS_API_KEY/credential" }
}
```

Resolution order: env var → `options.api_key` (plaintext, discouraged) →
`options.apiKeyCommand` (1Password `op`, macOS `security`, `pass`, …).

Useful commands:

```bash
npx @amenophis1er/claude-voice voices          # list system voices (try "Ava (Premium)" on macOS)
npx @amenophis1er/claude-voice test "Hello"    # hear the current voice right now
npx @amenophis1er/claude-voice list            # list providers
npx @amenophis1er/claude-voice config          # show active config + where it lives
```

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
| `voice` | Provider-specific voice name/id. |
| `rate` | Speech speed, `1` = normal. |
| `options` | Free-form provider extras, e.g. `{ "model_id": "eleven_turbo_v2_5" }`. |
| `throttleSeconds` | Minimum gap between two spoken summaries in one session. |
| `substantial` | A task must clear **one** threshold to be summarized. |
| `speakOnlyWhenUnfocused` | Speak only when your terminal is **not** the frontmost app (macOS). |
| `quietHours` | 24h local time; wraps midnight (`22 → 8` means 10pm–8am). |

Edit the file directly or rerun `npx @amenophis1er/claude-voice init` — changes apply on the
next task, no restart needed.

## Muting on purpose

Sometimes you want silence *now* — a call, a screen share, pairing. Three ways,
all equivalent:

```
/claude-voice mute 1h    # inside Claude Code (slash command, installed with the hooks)
/claude-voice unmute
/claude-voice status
```

(Why not `/voice`? That name is a Claude Code built-in.)

```bash
npx @amenophis1er/claude-voice mute 2h    # or: mute 30m, mute 1d, mute (= until unmute)
npx @amenophis1er/claude-voice unmute
```

A mute is **global** (all sessions — mute means the room goes quiet), survives
restarts, and expires on its own when given a duration. This is separate from
the *automatic* silencers: `quietHours` (config) and `speakOnlyWhenUnfocused`
(speak only when the terminal isn't the frontmost app).

## Nice to know

- **Parallel sessions don't fight:** state is per-session, so two Claude Code
  windows won't interrupt or throttle each other.
- **It shuts up when you type:** submitting a new prompt instantly kills any
  audio still playing.
- **It never stalls Claude:** hooks are async and audio plays in a detached
  worker process.
- **Notification cues are tailored:** permission prompt, idle, needs-input, and
  task-complete each get an appropriate phrase.

## Troubleshooting

- **Nothing is ever spoken** — restart Claude Code after installing; hooks load
  at startup. Then check `npx @amenophis1er/claude-voice test "hello"` produces audio at all.
- **Short tasks are silent** — by design. Lower the `substantial` thresholds or
  set `preset: "verbose"` to speak everything.
- **No chimes on Linux/Windows** — expected for now; summaries still speak.
- **Focus muting never mutes** — macOS asks for an Automation permission the
  first time; if denied, claude-voice fails *open* (it speaks). Grant it in
  System Settings → Privacy & Security → Automation.
- **Dig deeper** — set `CLAUDE_VOICE_DEBUG=1`; every hook then appends the
  reason something was (not) spoken to `$TMPDIR/claude-voice-debug.log`:
  throttled, quiet hours, not substantial, provider fallback, playback errors.

---

## For developers

Everything below is only relevant if you want to hack on claude-voice itself.

### Running from source

```bash
git clone https://github.com/amenophis1er/claude-voice.git && cd claude-voice
npm install
node src/cli.ts init      # wires hooks straight to the checkout's TypeScript
```

Running the TS directly requires **Node ≥ 23.6** (type stripping). A `Makefile`
wraps the npm scripts: `make init`, `make check`, `make say TEXT="hello"`.

### Build, test, dist

```bash
npm run check     # typecheck + build + decision-logic tests
npm test          # just the tests (test/verify.mjs, no framework)
npm run build     # compile src/ → dist/ (plain JS, import paths rewritten)
```

`dist/` is committed on purpose: Claude Code plugin installs clone the repo and
have no build step, so `hooks/hooks.json` points at the compiled files. CI
fails if `dist/` drifts from `src/` — run `npm run build` after changing
source.

The interesting logic is deliberately pure and tested: sanitization,
closing-sentence extraction, clamping, preset policies, transcript stats.
Audio I/O is kept at the edges.

### How it works

Four Claude Code hooks share one dispatcher (`src/dispatch.ts`):

- **`SessionStart`** injects an instruction teaching Claude to end substantial
  tasks with one natural, speakable closing sentence (visible prose — an
  earlier design hid it in an HTML comment, but Claude Code's terminal renderer
  prints comments literally, so it leaked).
- **`Stop`** reads the final message from the stable `last_assistant_message`
  hook field, sanitizes it (code/paths/URLs/markdown stripped), extracts the
  message's ending, clamps it (~350 chars), and speaks it. If Claude skipped
  the instruction, the same extraction degrades to a cleaned tail of the
  message.
- **`Notification`** chimes/speaks a cue tailored to the notification type.
- **`UserPromptSubmit`** kills all in-flight audio for the session.

Substantiality is measured best-effort from the transcript JSONL (tool calls +
duration since the last *human* message — tool results also arrive as
`type:"user"` entries and must not count as turn boundaries). Transcript
parsing is never load-bearing: if the internal format changes, summaries still
work.

### Releasing

Releases are CI-driven: bump the version in `package.json` + 
`.claude-plugin/plugin.json`, update `CHANGELOG.md`, then push a `v*` tag.
The release workflow runs the checks, publishes to npm (trusted publishing —
no token), and creates the GitHub release with generated notes.

### Adding a TTS provider

Two steps: implement the `TtsProvider` interface in a new file under
`src/providers/` (synthesize text → audio file; never play it yourself), and
register it in `src/providers/registry.ts`. Playback and interruption stay
centralized in `speak.ts`.

## License

MIT
