export type LinkIngestCommandMode = "ingest" | "capture";

export interface LinkIngestCommandTextInput {
  url: string;
  note?: string | null;
}

export interface PrefixLinkIngestCommand {
  mode: "ingest";
  text: string;
}

export function buildLinkIngestCommandText(input: LinkIngestCommandTextInput): string {
  const url = input.url.trim();
  const note = input.note?.trim();
  return [url, note].filter((part): part is string => Boolean(part)).join(" ");
}

export function parsePrefixLinkIngestCommand(content: string): PrefixLinkIngestCommand | undefined {
  const trimmed = content.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "ingest") return { mode: "ingest", text: "" };
  if (!lower.startsWith("ingest ")) return undefined;
  return { mode: "ingest", text: trimmed.slice("ingest".length).trim() };
}

export function linkIngestAcceptedTitle(mode: LinkIngestCommandMode): string {
  return mode === "capture" ? "Capture accepted" : "Link ingest accepted";
}

export function linkIngestUsage(mode: LinkIngestCommandMode): string {
  return mode === "capture"
    ? "/pi capture url:https://..."
    : "/pi ingest url:https://...";
}
