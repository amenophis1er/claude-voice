# claude-voice

Give Claude Code a voice — **selective and tasteful, quiet by default.** It speaks
a one-line summary when a *substantial* task ends, chimes when Claude needs you,
and otherwise stays silent. No "read every response aloud" firehose.

## Why another one?

Existing plugins either just play a sound, or read *everything* Claude says
(overwhelming). claude-voice is built around one idea: **say something only when
it's worth interrupting you.**

## The one knob: `preset`

| preset | needs-you notification | task end | mid-task |
| --- | --- | --- | --- |
| `silent` | — | — | — |
| `chimes` | chime | chime | — |
| **`summary`** (default) | chime + spoken | spoken summary, *substantial tasks only* | — |
| `verbose` | chime + spoken | spoken summary, always | opt-in milestones |

## How the summary stays good (not robotic)

A `SessionStart` hook teaches Claude to end substantial tasks with a
`⟨voice⟩one natural sentence⟨/voice⟩` marker. The `Stop` hook speaks *only* that
marker — a summary Claude wrote to be heard, not a read-back of the transcript.
No marker + a substantial task → it falls back to a cleaned, clamped version of
the last message. Trivial replies stay silent.

Guardrails: never speaks code/paths/URLs, throttles repeat summaries, and a new
prompt instantly cuts any audio that's still playing.

## Requirements

- Node ≥ 23.6 (runs the TypeScript hooks directly, no build step)
- macOS for the default `say` provider + `afplay` playback

## Providers

Zero-config default is macOS `say`. Quality upgrades are opt-in via env keys:

| id | needs | 
| --- | --- |
| `say` | nothing (default) |
| `elevenlabs` | `ELEVENLABS_API_KEY` |
| `openai` | `OPENAI_API_KEY` |

Adding a provider = one file in `src/providers/` + one line in `registry.ts`.

## Try it

```bash
node src/cli.ts list
node src/cli.ts test "Done. Tests pass and the build is green."
```

## Install as a Claude Code plugin

The repo ships a plugin manifest (`.claude-plugin/plugin.json` + `hooks/hooks.json`).
Or wire it manually in `~/.claude/settings.json` by pointing the `Stop`,
`Notification`, `UserPromptSubmit`, and `SessionStart` hooks at
`node <repo>/src/dispatch.ts <event>`.

## Config

`~/.claude/voice/config.json` (all optional; shown with defaults):

```json
{
  "preset": "summary",
  "provider": "say",
  "voice": null,
  "rate": 1,
  "throttleSeconds": 20,
  "substantial": { "minToolCalls": 3, "minDurationSeconds": 15 },
  "quietHours": { "start": 22, "end": 8 }
}
```

## Status

Early skeleton. Working: provider registry, `say`/ElevenLabs/OpenAI, preset
policy, marker extraction + sanitizing, playback + interrupt, dispatcher, hooks.
