function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || !(key in value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function formatUnknownError(error: unknown): string {
  return formatUnknownErrorInner(error, new Set()) || "unknown error";
}

function formatUnknownErrorInner(error: unknown, seen: Set<unknown>): string {
  if (error === undefined) return "undefined";
  if (error === null) return "null";
  if (typeof error === "string") return compact(error);
  if (typeof error !== "object") return String(error);
  if (seen.has(error)) return "[circular]";
  seen.add(error);

  const tag = field(error, "_tag");
  const operation = field(error, "operation");
  const timeoutMs = field(error, "timeoutMs");
  const cause = field(error, "cause");
  const message = error instanceof Error ? compact(error.message) : "";
  const name = error instanceof Error ? error.name : undefined;

  const parts: string[] = [];
  if (typeof tag === "string" && tag.trim()) parts.push(tag.trim());
  else if (name && name !== "Error") parts.push(name);

  if (message) parts.push(message);
  if (typeof operation === "string" && operation.trim()) parts.push(`operation=${operation.trim()}`);
  if (typeof timeoutMs === "number") parts.push(`timeoutMs=${timeoutMs}`);
  if (cause !== undefined) parts.push(`cause=${formatUnknownErrorInner(cause, seen)}`);

  if (parts.length > 0) return parts.join(": ");

  try {
    const json = JSON.stringify(error);
    if (json && json !== "{}") return json;
  } catch {
    // fall through to object tag
  }

  return Object.prototype.toString.call(error);
}
