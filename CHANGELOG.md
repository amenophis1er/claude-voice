# Changelog

## 0.5.0 — 2026-08-03

- **Tell parallel sessions apart:** spoken audio can be prefixed with the
  project folder name — "claude voice: Task complete." — so with several
  Claude Code sessions open you know which one is talking. New
  `announceProject` config: `"auto"` (default — prefix only while another
  session is active, tracked via per-session heartbeat files), `"always"`,
  or `"off"`. Adds a `SessionEnd` hook that unregisters sessions promptly.
- **Milestones are real now:** the `verbose` preset's promised mid-task
  narration is implemented — a new `PostToolUse` hook speaks Claude's latest
  short progress remark during long tasks. Heavily gated to stay tasteful:
  only once the turn is already substantial, never while other audio plays,
  at most one per `milestoneIntervalSeconds` (default 60), never the same
  remark twice, and the task-end summary interrupts a still-playing milestone.
- **ElevenLabs now honors `rate`:** the config field was documented for all
  providers but silently ignored by ElevenLabs; it now maps to
  `voice_settings.speed` (clamped to the API's 0.7–1.2 range).
- **One voice at a time:** audio playback is now serialized machine-wide via
  a lock (stale holders are detected by pid and stolen), so concurrent jobs —
  milestone + notification, or two sessions finishing together — queue instead
  of overlapping. Players also register their pid at spawn time, closing the
  ~100 ms startup window in which a second job could see silence.
- **No more mid-word crops:** when no sentence boundary fit inside the length
  clamp, the spoken text was hard-sliced mid-word ("…an ask for you, flagged
  i"). The clamp now degrades gracefully — sentence, else clause, else word
  boundary. Bare IP addresses are also stripped from spoken text (they read
  terribly and their dots confused the sentence detector).
- **On-demand recap:** `claude-voice recap` speaks where the most recent
  session stands — Claude Code's persisted idle recap (`away_summary`
  transcript entry) when that's the newest word, else the closing sentence of
  the last assistant message — prefixed with the project name. Built to hang
  off an OS-level hotkey (README ships a Karabiner double-tap-Right-Ctrl
  rule); speaks even while muted, since you explicitly asked.
- **No stale idle nudge:** "Claude is waiting for you" is skipped for 10
  minutes after a spoken summary — it arrived right after the summary and
  implied action was needed when the job was simply done. Silent finishes
  (trivial replies, below-threshold tasks) still get the nudge.

## 0.4.0 — 2026-08-03

- **Redesigned `init`:** arrow-key menus, styled steps, spinner, and a proper
  outro — zero dependencies, hand-rolled UI, with a plain numbered-prompt
  fallback when not in a TTY (pipes, CI).
- `init` now walks cloud providers through endpoint + API key setup: custom
  OpenAI-compatible endpoint URL (normalized: https:// and /v1 added when
  missing), and a key method choice — env var, paste (stored in config.json,
  chmod 600, masked on screen), or a fetch command (op read, security, pass).
- Re-running `init` merges with the existing config instead of overwriting it —
  hand-edited fields (thresholds, quiet hours, provider extras) survive.

## 0.3.0 — 2026-08-03

- **Bring your own TTS:** the `openai` provider accepts `options.baseUrl` and
  speaks to any OpenAI-compatible endpoint (Kokoro, LocalAI, self-hosted).
  With a custom base URL, `model` is only sent when explicitly configured.
- **API keys from secret managers:** cloud providers now resolve their key as
  env var → `options.api_key` → `options.apiKeyCommand` (a shell command whose
  stdout is the key, e.g. 1Password's `op read`). Hooks run outside your shell
  rc, so this is the reliable way to feed keys without exporting them globally.

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
