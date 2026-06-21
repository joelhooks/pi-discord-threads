import type { AppConfig } from "../config.js";
import { createRunQueueRuntimeClient } from "../engine/runtime.js";
import {
  buildRunControlDoctorReport,
  loadRunControlDoctorRegistry,
  type RunControlDoctorActivePointer,
  type RunControlDoctorDeadLetterRun,
  type RunControlDoctorReport,
} from "./doctor.js";
import type { ReconcileIssue } from "./reconcile.js";
import type { RunControlJobQueueSummary, RunControlWorkerRecord } from "./types.js";
import { isTerminalRunStatus } from "./types.js";

export interface RunControlInspectionSnapshot {
  checkedAt: string;
  activeRuns: RunControlDoctorActivePointer[];
  pendingJobs: RunControlJobQueueSummary;
  workers: RunControlWorkerRecord[];
  deadLetteredRuns: RunControlDoctorDeadLetterRun[];
  reconcileIssues: ReconcileIssue[];
}

export type DeploySafetyStatus = "safe" | "waiting" | "unsafe" | "unknown";
export type DeploySafetyReasonSeverity = "info" | "wait" | "unsafe" | "unknown";

export interface DeploySafetyReason {
  code: string;
  severity: DeploySafetyReasonSeverity;
  message: string;
  runId?: string;
  logicalThreadId?: string;
}

export interface DeploySafetyReport {
  status: DeploySafetyStatus;
  checkedAt: string;
  reasons: DeploySafetyReason[];
  preflightActiveRunCount: number;
  postflightActiveRunCount: number;
  postflightPendingCount: number;
}

export interface ClassifyDeploySafetyOptions {
  config: AppConfig;
  before: RunControlInspectionSnapshot;
  after: RunControlInspectionSnapshot;
  elapsedMs?: number;
}

export function snapshotFromRunControlDoctorReport(report: RunControlDoctorReport): RunControlInspectionSnapshot {
  return {
    checkedAt: report.checkedAt,
    activeRuns: report.activePointers,
    pendingJobs: report.pendingJobs,
    workers: report.workers,
    deadLetteredRuns: report.deadLetteredRuns,
    reconcileIssues: report.reconcile.issues,
  };
}

export async function loadRunControlInspectionSnapshot(config: AppConfig): Promise<RunControlInspectionSnapshot> {
  if (!config.runControl.enabled) {
    return {
      checkedAt: new Date().toISOString(),
      activeRuns: [],
      pendingJobs: { pendingCount: 0, consumers: [] },
      workers: [],
      deadLetteredRuns: [],
      reconcileIssues: [],
    };
  }

  const registry = await loadRunControlDoctorRegistry(config);
  const store = createRunQueueRuntimeClient(config);
  try {
    await store.warmup();
    return snapshotFromRunControlDoctorReport(await buildRunControlDoctorReport({ store, registry, config }));
  } finally {
    await store.close();
  }
}

export function classifyDeploySafety(options: ClassifyDeploySafetyOptions): DeploySafetyReport {
  const reasons: DeploySafetyReason[] = [];
  const { config, before, after } = options;
  const elapsedMs = Math.max(0, options.elapsedMs ?? 0);

  if (!config.runControl.enabled) {
    reasons.push({
      code: before.activeRuns.length > 0 || after.activeRuns.length > 0 || after.pendingJobs.pendingCount > 0
        ? "run-control-disabled-live-work"
        : "run-control-disabled",
      severity: "unknown",
      message: "Run control is disabled, so deploy cannot prove zero-lost-work restart safety from Redis ownership evidence.",
    });
    return reportFromReasons({ before, after, reasons });
  }

  const beforeDeadLetters = new Set(before.deadLetteredRuns.map((run) => run.runId));
  for (const run of after.deadLetteredRuns) {
    if (beforeDeadLetters.has(run.runId)) continue;
    reasons.push({
      code: "new-dead-lettered-run",
      severity: "unsafe",
      runId: run.runId,
      message: `Run ${run.runId} became dead-lettered by postflight.`,
    });
  }

  for (const issue of after.reconcileIssues) {
    if (issue.severity !== "error") continue;
    reasons.push({
      code: "postflight-reconcile-error",
      severity: "unknown",
      runId: issue.runId,
      logicalThreadId: issue.logicalThreadId,
      message: `Postflight reconcile reported ${issue.code}: ${issue.message}`,
    });
  }

  const afterActiveByLogicalThread = new Map(after.activeRuns.map((run) => [run.logicalThreadId, run]));
  const afterDeadLettersByRunId = new Map(after.deadLetteredRuns.map((run) => [run.runId, run]));

  for (const preflightRun of before.activeRuns) {
    const postflightRun = afterActiveByLogicalThread.get(preflightRun.logicalThreadId);
    if (!postflightRun) {
      const deadLetter = afterDeadLettersByRunId.get(preflightRun.runId);
      reasons.push({
        code: deadLetter ? "preflight-run-dead-lettered" : "preflight-run-missing-postflight",
        severity: "unsafe",
        runId: preflightRun.runId,
        logicalThreadId: preflightRun.logicalThreadId,
        message: deadLetter
          ? `Preflight active run ${preflightRun.runId} is dead-lettered after restart.`
          : `Preflight active run ${preflightRun.runId} no longer has an active pointer after restart.`,
      });
      continue;
    }

    if (postflightRun.runId !== preflightRun.runId) {
      reasons.push({
        code: "preflight-run-replaced-postflight",
        severity: "unsafe",
        runId: preflightRun.runId,
        logicalThreadId: preflightRun.logicalThreadId,
        message: `Preflight active run ${preflightRun.runId} was replaced by ${postflightRun.runId} after restart.`,
      });
      continue;
    }

    if (postflightRun.deadLetteredAt || afterDeadLettersByRunId.has(postflightRun.runId)) {
      reasons.push({
        code: "preflight-run-dead-lettered",
        severity: "unsafe",
        runId: postflightRun.runId,
        logicalThreadId: postflightRun.logicalThreadId,
        message: `Preflight active run ${postflightRun.runId} is dead-lettered after restart.`,
      });
      continue;
    }

    if (!postflightRun.status) {
      reasons.push({
        code: "preflight-run-status-unknown",
        severity: "unknown",
        runId: postflightRun.runId,
        logicalThreadId: postflightRun.logicalThreadId,
        message: `Preflight active run ${postflightRun.runId} still has an active pointer, but its status is unknown.`,
      });
      continue;
    }

    if (isTerminalRunStatus(postflightRun.status)) {
      reasons.push({
        code: "active-pointer-terminal-postflight",
        severity: "unknown",
        runId: postflightRun.runId,
        logicalThreadId: postflightRun.logicalThreadId,
        message: `Preflight active run ${postflightRun.runId} is terminal but still has an active pointer after restart.`,
      });
      continue;
    }

    if ((postflightRun.status === "running" || postflightRun.status === "finalizing") && (postflightRun.leaseTtlMs ?? 0) <= 0) {
      if (elapsedMs < config.runControl.leaseTtlMs) {
        reasons.push({
          code: "active-run-awaiting-reclaim",
          severity: "wait",
          runId: postflightRun.runId,
          logicalThreadId: postflightRun.logicalThreadId,
          message: `Run ${postflightRun.runId} is still active with an expired lease; wait for worker reclaim inside leaseTtlMs=${config.runControl.leaseTtlMs}.`,
        });
      } else {
        reasons.push({
          code: "active-run-lease-still-expired",
          severity: "unknown",
          runId: postflightRun.runId,
          logicalThreadId: postflightRun.logicalThreadId,
          message: `Run ${postflightRun.runId} still has an expired lease after the reclaim window.`,
        });
      }
      continue;
    }

    reasons.push({
      code: postflightRun.status === "queued" ? "active-run-pending" : "active-run-preserved",
      severity: "wait",
      runId: postflightRun.runId,
      logicalThreadId: postflightRun.logicalThreadId,
      message: `Run ${postflightRun.runId} is still ${postflightRun.status} after restart.`,
    });
  }

  if (before.activeRuns.length === 0 && after.activeRuns.length > 0) {
    for (const run of after.activeRuns) {
      reasons.push({
        code: "postflight-active-run",
        severity: "wait",
        runId: run.runId,
        logicalThreadId: run.logicalThreadId,
        message: `Postflight has active run ${run.runId}.`,
      });
    }
  }

  if (after.pendingJobs.pendingCount > 0) {
    reasons.push({
      code: "pending-jobs-present",
      severity: "wait",
      message: `Postflight has ${after.pendingJobs.pendingCount} pending run-control job(s).`,
    });
  }

  if (reasons.length === 0) {
    reasons.push({
      code: "idle-postflight",
      severity: "info",
      message: "No active run-control work or pending jobs were visible after restart.",
    });
  }

  return reportFromReasons({ before, after, reasons });
}

export function formatDeploySafetyReport(report: DeploySafetyReport): string {
  const lines = [
    `deploy safety: ${report.status}`,
    `checkedAt: ${report.checkedAt}`,
    `preflightActiveRuns: ${report.preflightActiveRunCount}`,
    `postflightActiveRuns: ${report.postflightActiveRunCount}`,
    `postflightPendingJobs: ${report.postflightPendingCount}`,
  ];
  for (const reason of report.reasons) {
    lines.push(`- [${reason.severity}] ${reason.code}: ${reason.message}${reason.runId ? ` run=${reason.runId}` : ""}${reason.logicalThreadId ? ` logicalThread=${reason.logicalThreadId}` : ""}`);
  }
  return lines.join("\n");
}

function reportFromReasons(input: {
  before: RunControlInspectionSnapshot;
  after: RunControlInspectionSnapshot;
  reasons: DeploySafetyReason[];
}): DeploySafetyReport {
  return {
    status: statusFromReasons(input.reasons),
    checkedAt: input.after.checkedAt,
    reasons: input.reasons,
    preflightActiveRunCount: input.before.activeRuns.length,
    postflightActiveRunCount: input.after.activeRuns.length,
    postflightPendingCount: input.after.pendingJobs.pendingCount,
  };
}

function statusFromReasons(reasons: DeploySafetyReason[]): DeploySafetyStatus {
  if (reasons.some((reason) => reason.severity === "unsafe")) return "unsafe";
  if (reasons.some((reason) => reason.severity === "unknown")) return "unknown";
  if (reasons.some((reason) => reason.severity === "wait")) return "waiting";
  return "safe";
}
