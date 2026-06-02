import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Attachment, Message } from "discord.js";
import type { AppConfig } from "./config.js";

const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;

export interface InlineImageContent {
  type: "image";
  mimeType: string;
  data: string;
}

export interface AttachmentPromptContext {
  prompt: string;
  images: InlineImageContent[];
}

export async function appendAttachmentContext(
  prompt: string,
  message: Message,
  config: AppConfig,
  threadId: string,
): Promise<AttachmentPromptContext> {
  if (!config.attachments.enabled || message.attachments.size === 0) return { prompt, images: [] };

  const saved: string[] = [];
  const skipped: string[] = [];
  const images: InlineImageContent[] = [];
  const outputDir = join(config.dataDir, "attachments", threadId, message.id);
  await mkdir(outputDir, { recursive: true });

  for (const attachment of message.attachments.values()) {
    const name = sanitizeFilename(attachment.name ?? `attachment-${attachment.id}`);
    const extension = extname(name).toLowerCase();
    const declaredContentType = normalizeContentType(attachment.contentType);

    if (attachment.size > config.attachments.maxBytes) {
      skipped.push(`${name} (${formatBytes(attachment.size)} exceeds max ${formatBytes(config.attachments.maxBytes)})`);
      continue;
    }

    if (!isAllowedAttachment(declaredContentType, extension, config)) {
      skipped.push(`${name} (${declaredContentType})`);
      continue;
    }

    const response = await fetch(attachment.url);
    if (!response.ok) {
      skipped.push(`${name} (download failed: HTTP ${response.status})`);
      continue;
    }

    const responseContentType = normalizeContentType(response.headers.get("content-type"));
    const contentType = declaredContentType === "unknown" ? responseContentType : declaredContentType;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > config.attachments.maxBytes) {
      skipped.push(`${name} (${formatBytes(buffer.length)} exceeds max ${formatBytes(config.attachments.maxBytes)})`);
      continue;
    }

    const filePath = join(outputDir, `${attachment.id}-${name}`);
    await writeFile(filePath, buffer);

    const supportedImageMimeType = detectSupportedImageMimeType(buffer) ?? supportedImageMimeTypeFromContentType(contentType);
    const metadata = formatAttachmentMetadata(attachment);
    const kind = classifyAttachment(contentType, extension);
    const inlineImage = supportedImageMimeType && buffer.length <= MAX_INLINE_IMAGE_BYTES
      ? {
          type: "image" as const,
          mimeType: supportedImageMimeType,
          data: buffer.toString("base64"),
        }
      : undefined;
    const inlineNote = supportedImageMimeType
      ? inlineImage
        ? "also attached inline for vision"
        : `not attached inline; exceeds inline image cap ${formatBytes(MAX_INLINE_IMAGE_BYTES)}`
      : undefined;

    if (inlineImage) images.push(inlineImage);

    saved.push([
      `${kind} ${name}`,
      `type=${contentType}`,
      `size=${formatBytes(buffer.length)}`,
      metadata,
      `path=${filePath}`,
      inlineNote,
    ].filter(Boolean).join("; "));
  }

  if (saved.length === 0 && skipped.length === 0) return { prompt, images };

  return {
    prompt: [
      prompt,
      "",
      "Discord attachment context:",
      ...saved.map((line) => `- saved ${line}`),
      ...skipped.map((line) => `- skipped ${line}`),
      "",
      "Attachment handling guidance:",
      "- Use the saved local file paths when the user asks about an attachment.",
      "- Images may also be attached inline for direct vision; use the saved file path if tool inspection is needed.",
      "- For audio/video, inspect the saved file with local tools when needed (for example file/ffprobe/ffmpeg/transcription tools if available).",
      "- For PDFs/documents/text, extract or read from the saved file path when needed.",
    ].join("\n"),
    images,
  };
}

function isAllowedAttachment(contentType: string, extension: string, config: AppConfig): boolean {
  const loweredContentType = contentType.toLowerCase();
  const prefixes = config.attachments.allowedContentTypePrefixes.map((prefix) => prefix.toLowerCase());
  if (prefixes.includes("*") || prefixes.includes("*/*")) return true;
  if (prefixes.some((prefix) => prefix.length > 0 && loweredContentType.startsWith(prefix))) return true;
  return extension.length > 0 && config.attachments.allowedExtensions.includes(extension);
}

function normalizeContentType(contentType: string | null | undefined): string {
  return contentType?.split(";")[0]?.trim().toLowerCase() || "unknown";
}

function classifyAttachment(contentType: string, extension: string): string {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("text/")) return "text";
  if (contentType === "application/pdf" || extension === ".pdf") return "document";
  return "file";
}

function formatAttachmentMetadata(attachment: Attachment): string | undefined {
  const metadata: string[] = [];
  if (typeof attachment.width === "number" && typeof attachment.height === "number") {
    metadata.push(`${attachment.width}x${attachment.height}`);
  }

  const maybeWithDuration = attachment as Attachment & { duration?: number };
  if (typeof maybeWithDuration.duration === "number") {
    metadata.push(`duration=${maybeWithDuration.duration.toFixed(2)}s`);
  }

  if (attachment.description) {
    metadata.push(`description=${attachment.description.replace(/\s+/g, " ").trim()}`);
  }

  return metadata.length > 0 ? metadata.join("; ") : undefined;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  const mib = kib / 1024;
  return `${mib.toFixed(1)} MiB`;
}

function supportedImageMimeTypeFromContentType(contentType: string): string | undefined {
  switch (contentType) {
    case "image/jpeg":
    case "image/png":
    case "image/gif":
    case "image/webp":
      return contentType;
    default:
      return undefined;
  }
}

function detectSupportedImageMimeType(buffer: Buffer): string | undefined {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return buffer[3] === 0xf7 ? undefined : "image/jpeg";
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWithAscii(buffer, 0, "GIF")) return "image/gif";
  if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP")) return "image/webp";
  return undefined;
}

function startsWith(buffer: Buffer, bytes: number[]): boolean {
  if (buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

function startsWithAscii(buffer: Buffer, offset: number, text: string): boolean {
  if (buffer.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index++) {
    if (buffer[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
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
