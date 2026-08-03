# claude-voice

Give Claude Code a voice — **selective and tasteful, quiet by default.** It speaks
a one-line summary when a *substantial* task ends, chimes when Claude needs you,
and otherwise stays silent. No "read every response aloud" firehose.

## Why another one?

Existing plugins either just play a sound, or read *everything* Claude says
(overwhelming). claude-voice is built around one idea: **say something only when
it's worth interrupting you.**

## Quick start

```bash
node src/cli.ts init      # interactive: pick preset/provider/voice, wire hooks
# then restart Claude Code
```

## The one knob: `preset`

| preset | needs-you notification | task end | mid-task |
| --- | --- | --- | --- |
| `silent` | — | — | — |
| `chimes` | chime | chime | — |
| **`summary`** (default) | chime + spoken | spoken summary, *substantial tasks only* | — |
| `verbose` | chime + spoken | spoken summary, always | opt-in milestones |

## How the summary stays good

A `SessionStart` hook teaches Claude to end substantial tasks with one natural,
speakable closing sentence — ordinary visible prose, no code, paths, or URLs.
The `Stop` hook then speaks the *ending* of the message: a sentence Claude wrote
to be heard, that also reads as a normal wrap-up in chat. If Claude skips the
instruction, the same extraction gracefully degrades to a cleaned, clamped tail
of the last message — the happy path and the fallback are one code path.
Trivial replies stay silent.

> Earlier versions hid the summary in an HTML comment, assuming Claude Code's
> terminal renderer strips comments the way GitHub does. It doesn't — they print
> literally. The comment form is still parsed for sessions started under the old
> instruction, but is no longer emitted.

Notification cues are tailored by `notification_type` (permission vs idle vs
needs-input vs complete).

Guardrails: never speaks code/paths/URLs · throttles repeat summaries
(per-session) · a new prompt instantly kills any audio still playing · optional
**focus muting** (speak only when the terminal isn't the frontmost app) · quiet
hours.

## Reliability

- **Non-blocking:** speak/notify hooks are marked `async` *and* play audio in a
  detached worker, so a hook never stalls the session.
- **Text comes from the stable `last_assistant_message` hook field**, not from
  parsing the transcript. Transcript parsing (Claude Code's internal, versioned
  JSONL) is best-effort and only feeds the "was this substantial?" heuristic —
  if it ever breaks, marker-based summaries still work.
- **Per-session state** (pid/throttle keyed by `session_id`) so parallel Claude
  sessions don't interrupt or throttle each other.
- Fetch timeouts on cloud providers · temp-audio cleanup · `CLAUDE_VOICE_DEBUG=1`
  writes a diagnostic log to `$TMPDIR/claude-voice-debug.log`.

## Providers

Zero-config default is the OS built-in engine (`system`): macOS `say`, Linux
`espeak-ng`, Windows SAPI. Quality upgrades are opt-in via env keys:

| id | needs |
| --- | --- |
| `system` | nothing (default) |
| `elevenlabs` | `ELEVENLABS_API_KEY` |
| `openai` | `OPENAI_API_KEY` |

Adding a provider = one file in `src/providers/` + one line in `registry.ts`.

## Requirements

- Node ≥ 23.6 (runs the TypeScript hooks directly, no build step)
- Playback: macOS `afplay` / Linux `paplay` / Windows PowerShell. Chimes are
  macOS-only for now.

## CLI

```bash
node src/cli.ts init            # interactive setup (recommended)
node src/cli.ts install         # wire hooks into ~/.claude/settings.json
node src/cli.ts uninstall       # remove them (idempotent)
node src/cli.ts list            # list providers
node src/cli.ts voices          # list system voices
node src/cli.ts test "Hello"    # synthesize + play a phrase
node src/cli.ts config          # show active config + path
```

Also ships a plugin manifest (`.claude-plugin/plugin.json` + `hooks/hooks.json`).

## Config

`~/.claude/voice/config.json` (all optional; shown with defaults):

```json
{
  "preset": "summary",
  "provider": "system",
  "voice": null,
  "rate": 1,
  "throttleSeconds": 20,
  "substantial": { "minToolCalls": 3, "minDurationSeconds": 15 },
  "speakOnlyWhenUnfocused": false,
  "quietHours": { "start": 22, "end": 8 }
}
```

## Tests

```bash
node test/verify.mjs    # pure decision-logic assertions
npx tsc --noEmit        # typecheck
```
