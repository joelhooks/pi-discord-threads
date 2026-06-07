import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "./config.js";
import type { ThreadRecord, WorkGraphMetadata } from "./registry.js";

export function rootWorkGraph(threadId: string): WorkGraphMetadata {
  return {
    nodeId: threadId,
    rootNodeId: threadId,
    relation: "root",
  };
}

export function forkWorkGraph(source: ThreadRecord, childThreadId: string, parentSessionFile?: string, createdFromEntryId?: string): WorkGraphMetadata {
  const sourceNodeId = source.workGraph?.nodeId ?? source.threadId;
  return {
    nodeId: childThreadId,
    rootNodeId: source.workGraph?.rootNodeId ?? sourceNodeId,
    parentThreadId: source.threadId,
    parentSessionFile,
    relation: "fork",
    createdFromEntryId,
  };
}

export function createForkedSessionFile(source: ThreadRecord, config: AppConfig): string | undefined {
  if (!source.sessionFile) return undefined;
  const forkManager = SessionManager.forkFrom(source.sessionFile, source.cwd, config.pi.sessionDir);
  return forkManager.getSessionFile();
}

export function formatWorkGraphStatus(record: ThreadRecord): string[] {
  const graph = record.workGraph;
  if (!graph) return [];
  const lines: string[] = [];
  if (graph.relation && graph.relation !== "root") lines.push(`relation: ${graph.relation}`);
  if (graph.parentThreadId) lines.push(`parent: <#${graph.parentThreadId}>`);
  if (graph.rootNodeId && graph.rootNodeId !== graph.nodeId) lines.push(`rootNode: ${graph.rootNodeId}`);
  if (graph.parentSessionFile) lines.push(`parentSession: ${graph.parentSessionFile}`);
  return lines;
}

export function formatWorkGraphEmbedDescription(record: ThreadRecord): string | undefined {
  const graph = record.workGraph;
  if (!graph || graph.relation === "root") return undefined;
  const parts = [
    graph.relation ? `relation: ${graph.relation}` : undefined,
    graph.parentThreadId ? `parent: <#${graph.parentThreadId}>` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}
