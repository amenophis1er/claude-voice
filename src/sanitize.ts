/**
 * Marker Claude emits to author a voice-native, one-line spoken summary.
 * It is an HTML comment on purpose: GitHub-flavored markdown (what Claude Code
 * renders) hides HTML comments, so the user never SEES the marker in chat, but
 * it survives verbatim in the raw transcript text that the Stop hook reads.
 * Both the modern `<!--voice: ...-->` form and the legacy ⟨voice⟩ form parse.
 */
const VOICE_MARKER = /(?:<!--\s*voice:\s*([\s\S]*?)\s*-->|⟨voice⟩([\s\S]*?)⟨\/voice⟩)/i;

/** Pull the hidden voice summary out of an assistant message, if present. */
export function extractVoiceMarker(text: string): string | undefined {
  const m = text.match(VOICE_MARKER);
  if (!m) return undefined;
  return (m[1] ?? m[2] ?? "").trim() || undefined;
}

/**
 * Turn message text into something worth hearing: drop code, paths, URLs, and
 * markdown noise that reads fine but sounds terrible spoken aloud.
 */
export function sanitizeForSpeech(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, " ") // hidden markers / html comments
    .replace(/```[\s\S]*?```/g, " ") // fenced code
    .replace(/`[^`]*`/g, " ") // inline code
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links/images → label
    .replace(/https?:\/\/\S+/g, " ") // bare URLs
    .replace(/\B(?:~|\.{0,2})\/[^\s)]+/g, " ") // file paths
    .replace(/[#*_>|]/g, " ") // markdown punctuation
    .replace(/\s+/g, " ")
    .trim();
}

/** Guard against reading a whole essay aloud when a marker is missing. */
export function clampSpokenLength(text: string, maxChars = 350): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "));
  return (lastStop > 80 ? cut.slice(0, lastStop + 1) : cut).trim();
}
