# Changelog

## 0.2.0 — 2026-08-02

- **Purposeful mute:** `claude-voice mute [30m|2h|1d]` / `unmute` / `status`,
  plus a `/voice` slash command installed alongside the hooks (and shipped in
  the plugin). A mute is global across sessions, survives restarts, and expires
  automatically when given a duration.

## 0.1.0 — 2026-08-02

First tagged release.

- **Spoken summaries via a visible closing sentence.** Claude is taught (via
  `SessionStart` context) to end substantial tasks with one natural, speakable
  sentence; the `Stop` hook speaks the message's ending. Replaces the original
  hidden HTML-comment marker, which Claude Code's terminal renderer printed
  literally instead of hiding. The old `<!--voice: ...-->` form is still parsed
  for sessions started under the previous instruction.
- Presets (`silent` / `chimes` / `summary` / `verbose`), notification cues
  tailored by type, per-session throttling and interruption, quiet hours,
  optional focus muting (macOS).
- Providers: OS built-in TTS (zero-config default), ElevenLabs, OpenAI —
  with automatic fallback to the system voice on provider failure.
- Non-blocking hooks: synthesis + playback run in a detached worker; a new
  prompt kills all in-flight audio for that session (chime and speech alike).
- Install via `claude-voice init` (interactive) or as a Claude Code plugin.
