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
  const activePointersByThread = new Map(activePointers.map((pointer) => [pointer.logicalThreadId, pointer]));

  for (const run of runs) {
    if ((run.status === "running" || run.status === "finalizing") && await isRunLeaseExpired(store, run)) {
      issues.push({
        code: "expired-worker-lease",
        severity: "warn",
        runId: run.runId,
        logicalThreadId: run.logicalThreadId,
        threadId: run.threadId,
        message: `Run ${run.runId} is ${run.status} but has no live worker lease.`,
        action: "leave pending for worker XAUTOCLAIM recovery",
      });
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
    let run = runsById.get(pointer.runId);
    if (!run) {
      // listRuns() and listActivePointers() are separate Redis scans. A run can be
      // enqueued between them, so re-read the pointed run before treating the
      // active pointer as orphaned. Otherwise reconcile can clear a fresh active
      // pointer and then interrupt the just-created run on the next pass.
      run = await store.getRun(pointer.runId);
      if (run) {
        runsById.set(run.runId, run);
        runs.push(run);
      }
    }
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

  for (const run of runs) {
    if (isTerminalRunStatus(run.status)) continue;
    const activeRunId = activePointersByThread.get(run.logicalThreadId)?.runId;
    if (activeRunId === run.runId) continue;
    const hasOtherActiveRun = Boolean(activeRunId);
    issues.push({
      code: hasOtherActiveRun ? "nonterminal-run-not-active" : "nonterminal-run-without-active-pointer",
      severity: "warn",
      runId: run.runId,
      logicalThreadId: run.logicalThreadId,
      threadId: run.threadId,
      message: hasOtherActiveRun
        ? `Run ${run.runId} is ${run.status}, but active pointer ${run.logicalThreadId} references ${activeRunId}.`
        : `Run ${run.runId} is ${run.status}, but ${run.logicalThreadId} has no active pointer.`,
      action: apply ? "mark run interrupted" : "would mark run interrupted",
    });
    if (apply) {
      await store.markTerminal(run.runId, "interrupted", {
        error: hasOtherActiveRun
          ? `reconciled non-active ${run.status} run; active pointer references ${activeRunId}`
          : `reconciled non-active ${run.status} run with no active pointer`,
        placeholderRetiredAt: checkedAt,
      });
      applied.push(`marked non-active run ${run.runId} interrupted`);
    }
  }

  const nonTerminalRunsByThread = new Map<string, RunRecord[]>();
  for (const run of runs) {
    if (isTerminalRunStatus(run.status)) continue;
    const existing = nonTerminalRunsByThread.get(run.logicalThreadId) ?? [];
    existing.push(run);
    nonTerminalRunsByThread.set(run.logicalThreadId, existing);
  }
  for (const [logicalThreadId, liveRuns] of nonTerminalRunsByThread.entries()) {
    if (liveRuns.length <= 1) continue;
    const activeRunId = activePointersByThread.get(logicalThreadId)?.runId;
    issues.push({
      code: "multiple-nonterminal-runs",
      severity: "warn",
      runId: activeRunId,
      logicalThreadId,
      threadId: liveRuns.find((run) => run.runId === activeRunId)?.threadId ?? liveRuns[0]?.threadId,
      message: `Logical thread ${logicalThreadId} has ${liveRuns.length} non-terminal Redis runs (${liveRuns.map((run) => `${run.runId}:${run.status}`).join(", ")}).`,
      action: "manual cleanup recommended; worker will only execute the active pointer run",
    });
  }

  for (const record of registry.listThreads()) {
    if (record.status !== "queued" && record.status !== "running") continue;
    const activeRunId = activePointersByThread.get(record.threadId)?.runId;
    if (!activeRunId) {
      issues.push({
        code: "registry-live-without-redis-active",
        severity: "warn",
        threadId: record.threadId,
        logicalThreadId: record.threadId,
        message: `Registry thread ${record.threadId} is ${record.status} but has no matching Redis active run.`,
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
      continue;
    }

    const run = runsById.get(activeRunId);
    if (!run || isTerminalRunStatus(run.status)) continue;
    const desiredStatus = run.status === "queued" ? "queued" : "running";
    const activeRunMismatch = record.activeRun?.runId !== run.runId;
    if (record.status !== desiredStatus || activeRunMismatch) {
      issues.push({
        code: "registry-live-run-mismatch",
        severity: "warn",
        runId: run.runId,
        threadId: record.threadId,
        logicalThreadId: record.threadId,
        message: `Registry thread ${record.threadId} says ${record.status}/${record.activeRun?.runId ?? "no-active-run"}, but Redis active run ${run.runId} is ${run.status}.`,
        action: apply ? `sync registry to ${desiredStatus}` : `would sync registry to ${desiredStatus}`,
      });
      if (apply) {
        await registry.patchThread(record.threadId, {
          status: desiredStatus,
          activeRun: activeRunFromRun(run),
          sessionFile: run.sessionFile ?? record.sessionFile,
        });
        applied.push(`synced registry thread ${record.threadId} to ${desiredStatus} run ${run.runId}`);
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
  let stopped = false;
  const runOnce = async () => {
    const report = await reconcileRunControl(options);
    if (!stopped && (report.issues.length > 0 || report.applied.length > 0)) {
      console.log(formatReconcileReport(report));
    }
  };
  const runOnceLogged = async () => {
    try {
      await runOnce();
    } catch (error) {
      if (stopped) return;
      const text = error instanceof Error ? error.message : String(error);
      console.warn(`run-control reconcile loop failed: ${text}`);
    }
  };
  const interval = setInterval(() => void runOnceLogged(), options.config.runControl.reconcileIntervalMs);
  interval.unref();
  void runOnceLogged();
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

const ACTIVE_RUN_PROMPT_LIMIT = 24_000;

function activeRunFromRun(run: RunRecord) {
  const prompt = run.prompt.length > ACTIVE_RUN_PROMPT_LIMIT
    ? `${run.prompt.slice(0, ACTIVE_RUN_PROMPT_LIMIT)}\n\n[truncated by pi-discord-threads active-run recovery metadata]`
    : run.prompt;
  return {
    runId: run.runId,
    sourceDiscordMessageId: run.sourceDiscordMessageId,
    placeholderDiscordMessageId: run.placeholderDiscordMessageId,
    prompt,
    promptPreview: run.promptPreview,
    startedAt: run.startedAt ?? run.createdAt,
    updatedAt: run.updatedAt,
    sessionFile: run.sessionFile,
  };
}

async function isRunLeaseExpired(store: RunControlStorePort, run: RunRecord): Promise<boolean> {
  const ttl = await store.getRunLeaseTtl(run.runId);
  if (ttl > 0) return false;
  return true;
}
