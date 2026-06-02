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
    .replace(/```[\s\S]*?```/g, "code block")
    .replace(/\s+/g, " ")
    .trim();
  const base = compact.length > 0 ? compact : "Pi session";
  const cleaned = cleanThreadTitle(base).replace(/[\n\r]/g, " ").slice(0, 86).trim();
  if (!cleaned) return "π Pi session";
  return `${threadTitleIcon(cleaned)} ${cleaned}`.slice(0, 95);
}

function cleanThreadTitle(value: string): string {
  return value
    .replace(/^\/skill:([\w-]+)\s*/i, "$1: ")
    .replace(/^workspace\s+/i, "")
    .replace(/^ask pi about this discord message\.?\s*/i, "Discord message: ")
    .replace(/^(please\s+)?(can you|could you|would you)\s+/i, "")
    .replace(/^(please\s+)?/i, "")
    .trim();
}

function threadTitleIcon(value: string): string {
  const lower = value.toLowerCase();
  if (/\b(workspace|aihero|cwd)\b/.test(lower)) return "🗂️";
  if (/\b(debug|diagnose|investigate|error|bug|broken|failing|failure|fix)\b/.test(lower)) return "🐛";
  if (/\b(research|review|audit|inspect|search|look into|how does|explain)\b/.test(lower)) return "🔎";
  if (/\b(doc|docs|readme|write|copy|content|prd|plan)\b/.test(lower)) return "📚";
  if (/\b(test|typecheck|lint|spec|coverage)\b/.test(lower)) return "🧪";
  if (/\b(push|publish|deploy|release|github|wzrrd)\b/.test(lower)) return "🚀";
  if (/\b(refactor|clean|rename|trim|simplify|polish)\b/.test(lower)) return "🧹";
  if (/\b(add|implement|build|create|make|support)\b/.test(lower)) return "✨";
  if (/\b(discord message|reply|thread)\b/.test(lower)) return "💬";
  return "π";
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
