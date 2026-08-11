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
| `verbose` | chime + spoken | spoken summary, always | spoken milestones |

"Substantial" means the task crossed a threshold (default: 3 tool calls or 15
seconds). Quick back-and-forth stays silent — that's the tasteful part.

**Milestones** (`verbose` only): during a long task, Claude's short progress
remarks ("Now turning both old copies into pointer stubs.") are spoken so you
can follow along from across the room — only once the task is already
substantial, at most one per minute, never repeating itself, and never talking
over other audio. Milestones are also *perishable*: a remark older than two
intervals is never spoken (during long agent runs the last remark can sit
unchanged for minutes), and if the speaker is busy a milestone is dropped, not
queued — a delayed glance is a wrong glance. The task-end summary always wins:
it cuts a still-playing milestone.

The summary you hear isn't a robotic read-back: Claude is taught (via a session
instruction the hooks inject) to end real tasks with one natural, speakable
closing sentence — no code, paths, or URLs — and that's what gets spoken.

## Voices and providers

The default (`system`) uses your OS's built-in text-to-speech: zero config, no
API keys, works offline. Three opt-in upgrades:

| provider | quality | needs |
| --- | --- | --- |
| `system` (default) | fine | nothing |
| `kokoro` | great | one-time local install (~350 MB) — free, offline |
| `elevenlabs` | best | `ELEVENLABS_API_KEY` in your environment |
| `openai` | great | `OPENAI_API_KEY` in your environment |

### Kokoro — neural voices, fully local

Kokoro is a small open-weights TTS model that runs on your CPU (no GPU
needed) faster than real time — neural-voice quality with no API key, no
network, no per-word cost:

```bash
claude-voice kokoro install      # venv + model under ~/.claude/voice/kokoro
claude-voice kokoro voice        # re-pick the voice — each speaks as you browse
claude-voice kokoro status       # install state, disk use, server state
claude-voice kokoro uninstall    # removes everything it installed
```

The install is self-contained under `~/.claude/voice/kokoro` (a private
Python venv plus the model — nothing global, no Homebrew packages), ends with
a spoken smoke test, and finishes with a voice picker where each voice
introduces itself as you arrow onto it. It needs Python 3.10–3.13 on your
PATH, or [`uv`](https://docs.astral.sh/uv/) (preferred — it fetches its own).

Synthesis runs through a tiny localhost server that starts on demand, is
pre-warmed when you submit a prompt, and exits by itself after 10 idle
minutes. Warm latency is a few hundred milliseconds (`claude-voice stats`
shows it as `synthesis kokoro`). Uninstalling deletes that one directory and
points config back at the system voice — nothing else to clean up.

**Bring your own TTS:** the `openai` provider works with any OpenAI-compatible
endpoint (LocalAI, a self-hosted server) — set `options.baseUrl` and
your key, and pick a voice your server knows:

```json
{
  "provider": "openai",
  "voice": "af_bella",
  "options": { "baseUrl": "https://tts.example.com/v1", "apiKeyCommand": "…" }
}
```

With a custom `baseUrl`, `model` is only sent if you set `options.model` —
your server's default is usually right.

If a provider fails (no key, kokoro not installed, network down, timeout), it
falls back to the system voice automatically — you still hear your summary.

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
npx @amenophis1er/claude-voice recap           # speak where the latest session stands
npx @amenophis1er/claude-voice stats           # audio latency + outcome metrics (24h; try `7d`, `--json`)
```

`stats` shows where the time goes between a hook firing and audio being
audible — dispatch overhead, TTS synthesis (per provider), speaker-queue
wait — plus outcomes: played, dropped (speaker busy), and upstream skips
(throttled, muted, quiet hours). Metrics are always on and cost nothing; the
JSONL file rotates at ~512 KB.

## On-demand recap (hotkey)

`claude-voice recap` finds your most recently active Claude Code session and
speaks where it stands — Claude Code's own idle recap when that's the newest
word, otherwise the closing sentence of the last assistant message — prefixed
with the project name. It speaks even while muted (you asked), which makes it
perfect on a global hotkey: glance away from the screen, tap the key, hear the
state of play.

Claude Code's in-app keybindings can't run commands (and terminals can't even
see a bare modifier tap), so bind it at the OS level.

**macOS, zero extra installs** — generate a ready-made Shortcut:

```bash
npx @amenophis1er/claude-voice shortcut
```

This builds the Shortcuts workflow with your machine's real paths, signs it
locally (macOS refuses unsigned shortcut files), and opens the import dialog.
Click *Add Shortcut*, then in the shortcut's ⓘ details panel assign a global
hotkey — ⌃⌥V is a safe, mnemonic choice (avoid ⌃⌥R: Claude Code uses it for
prompt search). The hotkey itself can't ship in the file; Apple stores those
per device.

The natural companion — especially with `"speech": "full"` — is a hotkey that
**shuts the voice up mid-word**:

```bash
npx @amenophis1er/claude-voice shortcut stop   # generate "Claude voice stop"
npx @amenophis1er/claude-voice stop            # same thing from a terminal
```

`stop` cuts whatever is playing right now, across all sessions, and says
nothing about the future (unlike `mute`). Typing a new prompt still interrupts
automatically, as always.

**Prefer a double-tap gesture?** Double-tap **Right Ctrl** with
[Karabiner-Elements](https://karabiner-elements.pqrs.org) (macOS):

```json
{
  "description": "Double-tap Right Ctrl → speak Claude session recap",
  "manipulators": [
    {
      "type": "basic",
      "from": { "key_code": "right_control", "modifiers": { "optional": ["any"] } },
      "conditions": [{ "type": "variable_if", "name": "rctrl_tap", "value": 1 }],
      "to": [{ "shell_command": "/opt/homebrew/bin/node $HOME/.claude/voice/app/cli.js recap" }]
    },
    {
      "type": "basic",
      "from": { "key_code": "right_control", "modifiers": { "optional": ["any"] } },
      "to": [
        { "key_code": "right_control" },
        { "set_variable": { "name": "rctrl_tap", "value": 1 } }
      ],
      "to_delayed_action": {
        "to_if_invoked": [{ "set_variable": { "name": "rctrl_tap", "value": 0 } }],
        "to_if_canceled": [{ "set_variable": { "name": "rctrl_tap", "value": 0 } }]
      }
    }
  ]
}
```

Adjust the `shell_command` for your setup: Karabiner runs with a minimal
`PATH`, so use an absolute `node` path (`which node`), and point at
`~/.claude/voice/app/cli.js` (npx install) or `<your clone>/src/cli.ts`
(source install). Raycast, Hammerspoon, or skhd work just as well with a
normal key combo.

## Configuration

`~/.claude/voice/config.json` — everything is optional; shown with defaults:

```json
{
  "preset": "summary",
  "speech": "closing",
  "provider": "system",
  "voice": null,
  "rate": 1,
  "options": {},
  "throttleSeconds": 20,
  "milestoneIntervalSeconds": 60,
  "substantial": { "minToolCalls": 3, "minDurationSeconds": 15 },
  "speakOnlyWhenUnfocused": false,
  "announceProject": "auto",
  "quietHours": { "start": 22, "end": 8 }
}
```

| field | meaning |
| --- | --- |
| `preset` | The one knob — see table above. It decides **when** to speak. |
| `speech` | How much of a spoken reply is read: `"closing"` (the closing sentence — default) or `"full"` (the entire reply, sanitized: code, paths, and URLs stripped). Full pairs best with `kokoro` — free, starts in ~0.5 s, and a new prompt cuts it off instantly. |
| `provider` | `system`, `kokoro`, `elevenlabs`, or `openai`. |
| `voice` | Provider-specific voice name/id. |
| `rate` | Speech speed, `1` = normal. |
| `options` | Free-form provider extras, e.g. `{ "model_id": "eleven_turbo_v2_5" }`. |
| `throttleSeconds` | Minimum gap between two spoken summaries in one session. |
| `milestoneIntervalSeconds` | Minimum gap between two spoken milestones (`verbose`). |
| `substantial` | A task must clear **one** threshold to be summarized. |
| `speakOnlyWhenUnfocused` | Speak only when your terminal is **not** the frontmost app (macOS). |
| `announceProject` | Prefix audio with the project folder name ("claude voice: Task complete."). `"auto"` = only while other sessions are active; `"always"`; `"off"`. |
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
- **You can tell sessions apart:** while more than one session is running,
  spoken audio is prefixed with the project folder name — "claude voice: Task
  complete." — so you know which window is talking (`announceProject`).
- **It shuts up when you type:** submitting a new prompt instantly kills any
  audio still playing.
- **It never stalls Claude:** hooks are async and audio plays in a detached
  worker process.
- **One voice at a time:** playback is serialized machine-wide — a milestone,
  a notification, and another session's summary queue up instead of talking
  over each other. (Synthesis still runs in parallel; only the speaker is
  exclusive.)
- **Notification cues are tailored:** permission prompt, idle, needs-input, and
  task-complete each get an appropriate phrase.
- **No stale "Claude is waiting for you":** the idle nudge is skipped for 10
  minutes after a spoken summary — you already heard the job is done. A
  *silent* finish (trivial reply, unheard question) still gets the nudge.

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

Six Claude Code hooks share one dispatcher (`src/dispatch.ts`):

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
  An `idle_prompt` is dropped while the session's last spoken summary is
  fresh (10 min) — it would just repeat, less accurately, what was said.
- **`UserPromptSubmit`** kills all in-flight audio for the session.
- **`PostToolUse`** (verbose preset) speaks Claude's latest progress remark as
  a mid-task milestone, gated hard: turn already substantial, no audio
  currently playing, minimum interval, no repeats. The remark is read from the
  transcript best-effort — if the internal format changes, milestones degrade
  to silence, never to wrong speech.
- **`SessionEnd`** removes the session's heartbeat file. Every other event
  refreshes it; `announceProject: "auto"` prefixes spoken text with the
  project name only while another session's heartbeat is fresh (< 30 min).

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
