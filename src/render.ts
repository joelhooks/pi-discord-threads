export function chunkForDiscord(text: string, maxChars: number): string[] {
  const normalized = text.trim().length > 0 ? text.trim() : "(no assistant text produced)";
  if (normalized.length <= maxChars) return [normalized];

  const chunks: string[] = [];
  let rest = normalized;
  while (rest.length > 0) {
    if (rest.length <= maxChars) {
      chunks.push(rest);
      break;
    }

    const slice = rest.slice(0, maxChars);
    const fenceIndex = slice.lastIndexOf("\n```");
    const paragraphIndex = slice.lastIndexOf("\n\n");
    const lineIndex = slice.lastIndexOf("\n");
    const spaceIndex = slice.lastIndexOf(" ");
    const splitAt = Math.max(fenceIndex > 200 ? fenceIndex + 1 : -1, paragraphIndex, lineIndex, spaceIndex);
    const cut = splitAt > 200 ? splitAt : maxChars;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  return chunks;
}

export function summarizeForThreadName(prompt: string): string {
  const compact = prompt
    .replace(/<@!?\d+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const base = compact.length > 0 ? compact : "pi session";
  const cleaned = base.replace(/[\n\r]/g, " ").slice(0, 80).trim();
  return cleaned.length > 0 ? `pi: ${cleaned}`.slice(0, 95) : "pi session";
}

export function stripBotMention(text: string, botUserId: string | null): string {
  if (!botUserId) return text.trim();
  return text.replace(new RegExp(`^<@!?${botUserId}>\\s*`), "").trim();
}

export function stripCommandPrefix(text: string, prefix: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith(prefix)) return undefined;
  return trimmed.slice(prefix.length).trim();
}
