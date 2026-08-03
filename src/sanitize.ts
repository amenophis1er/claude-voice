/**
 * LEGACY marker support only. Early versions asked Claude to hide the summary
 * in an HTML comment, on the (wrong) assumption that Claude Code's terminal
 * renderer strips comments like GitHub does — it doesn't; they print literally.
 * The current design instead teaches Claude to end substantial tasks with a
 * natural *visible* closing sentence, extracted by `extractClosingSentence`.
 * This parser remains so sessions started under the old instruction still work.
 */
const VOICE_MARKER = /(?:<!--\s*voice:\s*([\s\S]*?)\s*-->|⟨voice⟩([\s\S]*?)⟨\/voice⟩)/i;

/** Legacy: pull a hidden voice summary out of an assistant message, if present. */
export function extractVoiceMarker(text: string): string | undefined {
  const m = text.match(VOICE_MARKER);
  if (!m) return undefined;
  return (m[1] ?? m[2] ?? "").trim() || undefined;
}

/**
 * The primary summary path: Claude is taught to end substantial tasks with one
 * natural, speakable closing sentence, so speak the message's *ending*. Takes
 * the last sentence of the sanitized text, pulling in earlier sentences only
 * while the result is still too short to stand alone.
 */
export function extractClosingSentence(text: string, maxChars = 350): string {
  const clean = sanitizeForSpeech(text);
  if (!clean) return "";
  const parts = (clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [clean]).map((s) => s.trim());
  let out = "";
  for (let i = parts.length - 1; i >= 0; i--) {
    const candidate = out ? `${parts[i]} ${out}` : parts[i];
    if (out && candidate.length > maxChars) break;
    out = candidate;
    if (out.length >= 60) break; // one solid sentence is enough
  }
  return clampSpokenLength(out, maxChars);
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
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, " ") // IP addresses
    .replace(/[#*_>|]/g, " ") // markdown punctuation
    .replace(/\(\s*[,;:\s]*\)/g, " ") // parens left holding only punctuation
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Guard against reading a whole essay aloud when a marker is missing.
 * Degrades gracefully: end on a sentence if one fits, else a clause, else a
 * word — never a mid-word chop ("flagged i"), which sounds like the voice died.
 */
export function clampSpokenLength(text: string, maxChars = 350): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const sentence = Math.max(
    cut.lastIndexOf(". "),
    cut.lastIndexOf("! "),
    cut.lastIndexOf("? "),
  );
  if (sentence > 80) return cut.slice(0, sentence + 1).trim();
  const clause = Math.max(cut.lastIndexOf(", "), cut.lastIndexOf("; "), cut.lastIndexOf(" — "));
  if (clause > 80) return cut.slice(0, clause).trim();
  const word = cut.lastIndexOf(" ");
  return (word > 0 ? cut.slice(0, word) : cut).trim();
}
