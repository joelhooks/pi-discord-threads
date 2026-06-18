import { existsSync } from "node:fs";
import type { AppConfig } from "../config.js";
import type { RegistryPort } from "../registry.js";
import { isTerminalRunStatus, type RunControlStorePort, type RunRecord } from "./types.js";

export type ReconcileSeverity = "info" | "warn" | "error";

export interface ReconcileIssue {
  code: string;
  severity: ReconcileSeverity;
  message: string;
  runId?: string;
  logicalThreadId?: string;
  threadId?: string;
  action?: string;
}

export interface ReconcileReport {
  checkedAt: string;
  apply: boolean;
  issues: ReconcileIssue[];
  applied: string[];
}

export async function reconcileRunControl(options: {
  store: RunControlStorePort;
  registry: RegistryPort;
  config: AppConfig;
  apply: boolean;
}): Promise<ReconcileReport> {
  const { store, registry, config, apply } = options;
  const checkedAt = new Date().toISOString();
  const issues: ReconcileIssue[] = [];
  const applied: string[] = [];

  const runs = await store.listRuns();
  const runsById = new Map(runs.map((run) => [run.runId, run]));
  const activePointers = await store.listActivePointers();

  for (const run of runs) {
    if ((run.status === "running" || run.status === "finalizing") && await isRunLeaseExpired(store, run)) {
      issues.push({
        code: "expired-worker-lease",
        severity: "warn",
        runId: run.runId,
        logicalThreadId: run.logicalThreadId,
        threadId: run.threadId,
        message: `Run ${run.runId} is ${run.status} but has no live worker lease.`,
        action: apply ? "mark interrupted and clear active pointer" : "would mark interrupted/reclaimable",
      });
      if (apply) {
        await store.markTerminal(run.runId, "interrupted", { error: "reconciler: worker lease expired" });
        await store.clearActiveIfMatches(run.logicalThreadId, run.runId);
        applied.push(`marked run ${run.runId} interrupted`);
      }
    }

    if (isTerminalRunStatus(run.status) && run.placeholderDiscordMessageId && !run.placeholderRetiredAt) {
      issues.push({
        code: "terminal-placeholder-not-retired",
        severity: "warn",
        runId: run.runId,
        logicalThreadId: run.logicalThreadId,
        threadId: run.threadId,
        message: `Run ${run.runId} is terminal (${run.status}) but has no placeholderRetiredAt marker.`,
        action: apply ? "mark placeholder retired to suppress repeated warnings" : "would mark placeholder retired after manual Discord check",
      });
      if (apply) {
        await store.patchRun(run.runId, { placeholderRetiredAt: checkedAt });
        applied.push(`marked placeholder retired for terminal run ${run.runId}`);
      }
    }

    const record = registry.getThread(run.threadId);
    if (!record) {
      issues.push({
        code: "missing-registry-thread",
        severity: "error",
        runId: run.runId,
        logicalThreadId: run.logicalThreadId,
        threadId: run.threadId,
        message: `Redis run ${run.runId} points at registry thread ${run.threadId}, but no registry record exists.`,
      });
    }

    const sessionFile = run.sessionFile || record?.sessionFile;
    if (sessionFile && !existsSync(sessionFile)) {
      issues.push({
        code: "missing-session-file",
        severity: "error",
        runId: run.runId,
        logicalThreadId: run.logicalThreadId,
        threadId: run.threadId,
        message: `Run ${run.runId} references missing Pi session file: ${sessionFile}`,
      });
    }
  }

  for (const pointer of activePointers) {
    const run = runsById.get(pointer.runId);
    if (!run) {
      issues.push({
        code: "active-pointer-missing-run",
        severity: "warn",
        runId: pointer.runId,
        logicalThreadId: pointer.logicalThreadId,
        message: `Active pointer ${pointer.logicalThreadId} references missing run ${pointer.runId}.`,
        action: apply ? "clear active pointer" : "would clear active pointer",
      });
      if (apply) {
        await store.clearActiveIfMatches(pointer.logicalThreadId, pointer.runId);
        applied.push(`cleared missing active pointer for ${pointer.logicalThreadId}`);
      }
      continue;
    }

    if (isTerminalRunStatus(run.status)) {
      issues.push({
        code: "active-pointer-terminal-run",
        severity: "warn",
        runId: run.runId,
        logicalThreadId: pointer.logicalThreadId,
        threadId: run.threadId,
        message: `Active pointer ${pointer.logicalThreadId} still points at terminal run ${run.runId} (${run.status}).`,
        action: apply ? "clear active pointer" : "would clear active pointer",
      });
      if (apply) {
        await store.clearActiveIfMatches(pointer.logicalThreadId, run.runId);
        applied.push(`cleared terminal active pointer for ${pointer.logicalThreadId}`);
      }
    }
  }

  for (const record of registry.listThreads()) {
    if (record.status !== "running") continue;
    const activeRunId = activePointers.find((pointer) => pointer.logicalThreadId === record.threadId)?.runId;
    if (!activeRunId) {
      issues.push({
        code: "registry-running-without-redis-active",
        severity: "warn",
        threadId: record.threadId,
        logicalThreadId: record.threadId,
        message: `Registry thread ${record.threadId} is running but has no matching Redis active run.`,
        action: apply ? "mark registry thread interrupted" : "would mark registry thread interrupted",
      });
      if (apply) {
        await registry.patchThread(record.threadId, {
          status: "interrupted",
          activeRun: record.activeRun
            ? { ...record.activeRun, interruptedAt: record.activeRun.interruptedAt ?? checkedAt, updatedAt: checkedAt }
            : undefined,
        });
        applied.push(`marked registry thread ${record.threadId} interrupted`);
      }
    }
  }

  if (apply && applied.length > 0) {
    await registry.save();
  }

  return { checkedAt, apply, issues, applied };
}

export function formatReconcileReport(report: ReconcileReport): string {
  const lines = [
    `run-control reconcile ${report.apply ? "apply" : "dry-run"}`,
    `checkedAt: ${report.checkedAt}`,
    `issues: ${report.issues.length}`,
  ];
  if (report.issues.length > 0) {
    for (const issue of report.issues) {
      lines.push(`- [${issue.severity}] ${issue.code}: ${issue.message}${issue.action ? ` (${issue.action})` : ""}`);
    }
  }
  if (report.applied.length > 0) {
    lines.push("applied:");
    for (const action of report.applied) lines.push(`- ${action}`);
  }
  return lines.join("\n");
}

export function startRunControlReconcileLoop(options: {
  store: RunControlStorePort;
  registry: RegistryPort;
  config: AppConfig;
  apply: boolean;
}): () => void {
  const runOnce = async () => {
    const report = await reconcileRunControl(options);
    if (report.issues.length > 0 || report.applied.length > 0) {
      console.log(formatReconcileReport(report));
    }
  };
  const interval = setInterval(() => void runOnce().catch((error) => {
    const text = error instanceof Error ? error.message : String(error);
    console.warn(`run-control reconcile loop failed: ${text}`);
  }), options.config.runControl.reconcileIntervalMs);
  interval.unref();
  void runOnce().catch(() => undefined);
  return () => clearInterval(interval);
}

async function isRunLeaseExpired(store: RunControlStorePort, run: RunRecord): Promise<boolean> {
  const ttl = await store.getRunLeaseTtl(run.runId);
  if (ttl > 0) return false;
  return true;
}
