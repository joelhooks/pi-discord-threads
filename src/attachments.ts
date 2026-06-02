import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Message } from "discord.js";
import type { AppConfig } from "./config.js";

export async function appendAttachmentContext(
  prompt: string,
  message: Message,
  config: AppConfig,
  threadId: string,
): Promise<string> {
  if (!config.attachments.enabled || message.attachments.size === 0) return prompt;

  const saved: string[] = [];
  const skipped: string[] = [];
  const outputDir = join(config.dataDir, "attachments", threadId, message.id);
  await mkdir(outputDir, { recursive: true });

  for (const attachment of message.attachments.values()) {
    const name = sanitizeFilename(attachment.name ?? `attachment-${attachment.id}`);
    const contentType = attachment.contentType ?? "unknown";
    const extension = extname(name).toLowerCase();

    if (attachment.size > config.attachments.maxBytes) {
      skipped.push(`${name} (${attachment.size} bytes exceeds max ${config.attachments.maxBytes})`);
      continue;
    }

    if (!isAllowedAttachment(contentType, extension, config)) {
      skipped.push(`${name} (${contentType})`);
      continue;
    }

    const response = await fetch(attachment.url);
    if (!response.ok) {
      skipped.push(`${name} (download failed: HTTP ${response.status})`);
      continue;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > config.attachments.maxBytes) {
      skipped.push(`${name} (${buffer.length} bytes exceeds max ${config.attachments.maxBytes})`);
      continue;
    }

    const filePath = join(outputDir, `${attachment.id}-${name}`);
    await writeFile(filePath, buffer);
    saved.push(`${name} (${contentType}, ${buffer.length} bytes): ${filePath}`);
  }

  if (saved.length === 0 && skipped.length === 0) return prompt;

  return [
    prompt,
    "",
    "Discord attachment context:",
    ...saved.map((line) => `- saved ${line}`),
    ...skipped.map((line) => `- skipped ${line}`),
  ].join("\n");
}

function isAllowedAttachment(contentType: string, extension: string, config: AppConfig): boolean {
  const loweredContentType = contentType.toLowerCase();
  if (config.attachments.allowedContentTypePrefixes.some((prefix) => loweredContentType.startsWith(prefix.toLowerCase()))) {
    return true;
  }
  return extension.length > 0 && config.attachments.allowedExtensions.includes(extension);
}

function sanitizeFilename(filename: string): string {
  const cleaned = filename
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
  return cleaned || "attachment";
}
