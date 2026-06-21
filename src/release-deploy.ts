import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AppConfig, RunControlRole } from "./config.js";
import { expandPath, loadConfig } from "./config.js";
import {
  assertOutsideLaunchAgentDaemon,
  getLaunchAgentPaths,
  restartLaunchAgent,
  writeLaunchAgentPlist,
} from "./launch-agent.js";
import {
  activateRelease,
  backupAndRestoreReleaseConfig,
  createReleaseSnapshot,
  recordReleaseDeploy,
  recordReleaseRollback,
  runReleaseCanary,
  type ActivateReleaseOptions,
  type ReleaseActivationResult,
  type ReleaseCanaryOptions,
  type ReleaseCanaryResult,
  type ReleaseConfigRestoreOptions,
  type ReleaseConfigRestoreResult,
  type ReleaseSnapshotOptions,
  type ReleaseSnapshotResult,
} from "./release-snapshots.js";
import {
  classifyDeploySafety,
  formatDeploySafetyReport,
  loadRunControlInspectionSnapshot,
  type DeploySafetyReport,
  type RunControlInspectionSnapshot,
} from "./run-control/inspection.js";
import {
  runReleaseDeployTransition,
  type ReleaseDeployTransitionResult,
  type ReleaseTransitionAdapters,
  type ReleaseTransitionLaunchAgentGuard,
} from "./release-transition.js";

const execFileAsync = promisify(execFile);

export interface BuildReleaseInput {
  projectRoot: string;
}

export interface BuildReleaseResult {
  command: "npm run build" | string;
  cwd: string;
  stdout?: string;
  stderr?: string;
}

export interface RunReleaseDeployCommandOptions {
  config: AppConfig;
  configPath: string;
  projectRoot?: string;
  roles?: RunControlRole[];
  force?: boolean;
  now?: Date;
}

export interface ReleaseDeployAuthorityGuardInput {
  config: AppConfig;
  configPath: string;
  roles: RunControlRole[];
  force: boolean;
}

export interface RunReleaseDeployCommandDeps {
  assertDeployAuthority?(input: ReleaseDeployAuthorityGuardInput): Promise<void | ReleaseTransitionLaunchAgentGuard>;
  build?(input: BuildReleaseInput): Promise<BuildReleaseResult>;
  createSnapshot?(input: ReleaseSnapshotOptions): Promise<ReleaseSnapshotResult>;
  transitionAdapters?: ReleaseTransitionAdapters;
  recordDeploy?(input: {
    config: AppConfig;
    configPath: string;
    releaseId: string;
    outcome: ReleaseDeployTransitionResult["outcome"] | "failed";
    safety?: DeploySafetyReport;
    transition?: ReleaseDeployTransitionResult;
    errorCode?: string;
  }): Promise<void>;
}

export interface ReleaseDeployCommandResult {
  releaseId: string;
  build: BuildReleaseResult;
  snapshot: ReleaseSnapshotResult;
  transition: ReleaseDeployTransitionResult;
}

export interface ReleaseRollbackOperationInput {
  config: AppConfig;
  configPath: string;
  target: string;
  roles: RunControlRole[];
  force: boolean;
}

export interface ReleaseRollbackConfigRestoreOutput {
  releaseId: string;
  backupPath?: string;
  summary?: string;
}

export interface ReleaseRollbackCommandResult {
  releaseId: string;
  preflight: RunControlInspectionSnapshot;
  guard: ReleaseTransitionLaunchAgentGuard;
  canary: ReleaseCanaryResult | { releaseId: string; summary?: string };
  configRestore: ReleaseConfigRestoreResult | ReleaseRollbackConfigRestoreOutput;
  activation: ReleaseActivationResult | { releaseId: string; previousReleaseId?: string; currentPath?: string; entryPath?: string };
  plist: { plistPath: string; entryPath: string; summary?: string };
  restart: { serviceTarget: string; summary?: string };
  postflight: RunControlInspectionSnapshot;
  safety: DeploySafetyReport;
}

export interface RunReleaseRollbackCommandOptions {
  config: AppConfig;
  configPath: string;
  target: string;
  roles?: RunControlRole[];
  force?: boolean;
  automatic?: boolean;
}

export interface RunReleaseRollbackCommandDeps {
  release?: {
    canary?(input: ReleaseRollbackOperationInput): Promise<ReleaseCanaryResult | { releaseId: string; summary?: string }>;
    restoreConfig?(input: ReleaseRollbackOperationInput): Promise<ReleaseConfigRestoreResult | ReleaseRollbackConfigRestoreOutput>;
    activate?(input: ReleaseRollbackOperationInput & { restoredConfig: AppConfig }): Promise<ReleaseActivationResult | { releaseId: string; previousReleaseId?: string; currentPath?: string; entryPath?: string }>;
  };
  launchAgent?: {
    assertOutsideDaemon(input: ReleaseRollbackOperationInput): Promise<ReleaseTransitionLaunchAgentGuard>;
    writePlist(input: Omit<ReleaseRollbackOperationInput, "target" | "force"> & { config: AppConfig; guard: ReleaseTransitionLaunchAgentGuard }): Promise<{ plistPath: string; entryPath: string; summary?: string }>;
    restart(input: Pick<ReleaseRollbackOperationInput, "force"> & { config: AppConfig; guard: ReleaseTransitionLaunchAgentGuard }): Promise<{ serviceTarget: string; summary?: string }>;
  };
  runtime?: {
    inspect(input: { phase: "preflight" | "postflight"; config: AppConfig }): Promise<RunControlInspectionSnapshot>;
    classify(input: { config: AppConfig; before: RunControlInspectionSnapshot; after: RunControlInspectionSnapshot; elapsedMs: number }): DeploySafetyReport;
  };
  loadConfig?(configPath: string): Promise<AppConfig>;
  recordRollback?(input: {
    config: AppConfig;
    configPath: string;
    releaseId: string;
    automatic: boolean;
    result: ReleaseRollbackCommandResult;
  }): Promise<void>;
}

export async function runReleaseDeployCommand(
  options: RunReleaseDeployCommandOptions,
  deps: RunReleaseDeployCommandDeps = {},
): Promise<ReleaseDeployCommandResult> {
  const projectRoot = resolve(options.projectRoot ?? resolveProjectRoot());
  const configPath = expandPath(options.configPath);
  const roles = options.roles ?? options.config.runControl.roles;
  const force = options.force ?? false;
  await (deps.assertDeployAuthority ?? assertRealDeployAuthority)({
    config: options.config,
    configPath,
    roles,
    force,
  });
  const build = await (deps.build ?? buildReleaseProject)({ projectRoot });
  const snapshot = await (deps.createSnapshot ?? createReleaseSnapshot)({
    config: options.config,
    configPath,
    allowDirty: false,
    projectRoot,
    ...(options.now ? { now: options.now } : {}),
  });
  let transition: ReleaseDeployTransitionResult;
  try {
    transition = await runReleaseDeployTransition({
      config: options.config,
      configPath,
      target: snapshot.releaseId,
      roles,
      force,
      adapters: deps.transitionAdapters ?? createRealReleaseTransitionAdapters(options),
    });
  } catch (error) {
    await (deps.recordDeploy ?? recordDeployResult)({
      config: options.config,
      configPath: options.configPath,
      releaseId: snapshot.releaseId,
      outcome: "failed",
      errorCode: "transition-error",
    });
    throw error;
  }

  await (deps.recordDeploy ?? recordDeployResult)({
    config: options.config,
    configPath: options.configPath,
    releaseId: snapshot.releaseId,
    outcome: transition.outcome,
    safety: transition.safety,
    transition,
  });

  return { releaseId: snapshot.releaseId, build, snapshot, transition };
}

export async function runReleaseRollbackCommand(
  options: RunReleaseRollbackCommandOptions,
  deps: RunReleaseRollbackCommandDeps = {},
): Promise<ReleaseRollbackCommandResult> {
  const initialRoles = options.config.runControl.roles;
  const force = options.force ?? false;
  const configPath = expandPath(options.configPath);
  const operation: ReleaseRollbackOperationInput = {
    config: options.config,
    configPath,
    target: options.target,
    roles: initialRoles,
    force,
  };
  const runtime = deps.runtime ?? realRollbackRuntimeAdapter();
  const release = deps.release ?? realRollbackReleaseAdapter();
  const launchAgent = deps.launchAgent ?? realRollbackLaunchAgentAdapter();

  const preflight = await runtime.inspect({ phase: "preflight", config: options.config });
  const guard = await launchAgent.assertOutsideDaemon(operation);
  const canary = await release.canary?.(operation) ?? await realRollbackReleaseAdapter().canary(operation);
  const configRestore = await release.restoreConfig?.(operation) ?? await realRollbackReleaseAdapter().restoreConfig(operation);
  const restoredConfig = await (deps.loadConfig ?? loadConfig)(configPath);
  assertSameDataDir(options.config, restoredConfig);
  const restoredOperation = { ...operation, config: restoredConfig, roles: options.roles ?? restoredConfig.runControl.roles };
  const activation = await release.activate?.({ ...restoredOperation, restoredConfig }) ?? await realRollbackReleaseAdapter().activate({ ...restoredOperation, restoredConfig });
  const plist = await launchAgent.writePlist({
    config: restoredConfig,
    configPath,
    roles: restoredOperation.roles,
    guard,
  });
  const restart = await launchAgent.restart({ config: restoredConfig, force, guard });
  const postflight = await runtime.inspect({ phase: "postflight", config: restoredConfig });
  const safety = runtime.classify({
    config: restoredConfig,
    before: preflight,
    after: postflight,
    elapsedMs: elapsedBetween(preflight, postflight),
  });

  const result: ReleaseRollbackCommandResult = {
    releaseId: releaseIdFromActivation(activation, options.target),
    preflight,
    guard,
    canary,
    configRestore,
    activation,
    plist,
    restart,
    postflight,
    safety,
  };

  await (deps.recordRollback ?? recordRollbackResult)({
    config: restoredConfig,
    configPath,
    releaseId: result.releaseId,
    automatic: options.automatic ?? false,
    result,
  });

  return result;
}

export function createRealReleaseTransitionAdapters(options: RunReleaseDeployCommandOptions): ReleaseTransitionAdapters {
  return {
    release: {
      async canary(input) {
        const result = await runReleaseCanary({
          config: input.config,
          configPath: input.configPath,
          target: input.target,
        });
        return { releaseId: result.release.releaseId, summary: `canary ok: ${result.entryPath}` };
      },
      async activate(input) {
        const result = await activateRelease({ config: input.config, target: input.target });
        return {
          releaseId: result.release.releaseId,
          ...(result.previousReleaseId ? { previousReleaseId: result.previousReleaseId } : {}),
          currentPath: result.currentPath,
          entryPath: result.entryPath,
          summary: `current -> ${result.currentPath}`,
        };
      },
      async rollback(input) {
        const result = await runReleaseRollbackCommand({
          config: input.config,
          configPath: input.configPath,
          target: input.target,
          force: input.force,
          automatic: true,
        });
        return { releaseId: result.releaseId, safety: result.safety, summary: `automatic rollback to ${result.releaseId}` };
      },
    },
    launchAgent: realTransitionLaunchAgentAdapter(),
    runtime: realTransitionRuntimeAdapter(options.config),
  };
}

export function formatReleaseDeployCommandResult(result: ReleaseDeployCommandResult): string {
  const lines = [
    `release deploy: ${result.releaseId}`,
    `outcome: ${result.transition.outcome}`,
    `build: ${result.build.command} (${result.build.cwd})`,
    `snapshot: ${result.snapshot.releasePath}`,
    `previous: ${result.transition.activation.previousReleaseId ?? "(none)"}`,
    `entry: ${result.transition.plist.entryPath}`,
    `service: ${result.transition.restart.serviceTarget}`,
    formatDeploySafetyReport(result.transition.safety),
  ];
  if (result.transition.rollback) {
    lines.push(`automaticRollback: ${result.transition.rollback.releaseId}`);
    lines.push(formatDeploySafetyReport(result.transition.rollback.safety));
  }
  return lines.join("\n");
}

export function formatReleaseRollbackCommandResult(result: ReleaseRollbackCommandResult): string {
  return [
    `release rollback: ${result.releaseId}`,
    `backup: ${"backupPath" in result.configRestore ? result.configRestore.backupPath ?? "(none)" : "(none)"}`,
    `entry: ${result.plist.entryPath}`,
    `service: ${result.restart.serviceTarget}`,
    formatDeploySafetyReport(result.safety),
  ].join("\n");
}

async function assertRealDeployAuthority(input: ReleaseDeployAuthorityGuardInput): Promise<ReleaseTransitionLaunchAgentGuard> {
  const paths = getLaunchAgentPaths(input.config);
  await assertOutsideLaunchAgentDaemon(paths);
  return { checkedAt: new Date().toISOString(), summary: `outside ${paths.label}` };
}

async function buildReleaseProject(input: BuildReleaseInput): Promise<BuildReleaseResult> {
  try {
    const result = await execFileAsync("npm", ["run", "build"], {
      cwd: input.projectRoot,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    return { command: "npm run build", cwd: input.projectRoot, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const details = formatExecError(error);
    throw new Error(`release deploy build failed: ${details}`);
  }
}

function realTransitionLaunchAgentAdapter(): ReleaseTransitionAdapters["launchAgent"] {
  return {
    async assertOutsideDaemon(input) {
      const paths = getLaunchAgentPaths(input.config);
      await assertOutsideLaunchAgentDaemon(paths);
      return { checkedAt: new Date().toISOString(), summary: `outside ${paths.label}` };
    },
    async writePlist(input) {
      const result = await writeLaunchAgentPlist({
        config: input.config,
        configPath: input.configPath,
        roles: input.roles,
      });
      return { plistPath: result.plistPath, entryPath: result.entryPath };
    },
    async restart(input) {
      const result = await restartLaunchAgent({ config: input.config, force: input.force });
      return { serviceTarget: result.serviceTarget };
    },
  };
}

function realRollbackLaunchAgentAdapter(): NonNullable<RunReleaseRollbackCommandDeps["launchAgent"]> {
  return {
    async assertOutsideDaemon(input) {
      const paths = getLaunchAgentPaths(input.config);
      await assertOutsideLaunchAgentDaemon(paths);
      return { checkedAt: new Date().toISOString(), summary: `outside ${paths.label}` };
    },
    async writePlist(input) {
      const result = await writeLaunchAgentPlist({
        config: input.config,
        configPath: input.configPath,
        roles: input.roles,
      });
      return { plistPath: result.plistPath, entryPath: result.entryPath };
    },
    async restart(input) {
      const result = await restartLaunchAgent({ config: input.config, force: input.force });
      return { serviceTarget: result.serviceTarget };
    },
  };
}

function realTransitionRuntimeAdapter(config: AppConfig): ReleaseTransitionAdapters["runtime"] {
  return {
    async inspect() {
      return loadRunControlInspectionSnapshot(config);
    },
    classify(input) {
      return classifyDeploySafety(input);
    },
  };
}

function realRollbackRuntimeAdapter(): NonNullable<RunReleaseRollbackCommandDeps["runtime"]> {
  return {
    async inspect(input) {
      return loadRunControlInspectionSnapshot(input.config);
    },
    classify(input) {
      return classifyDeploySafety(input);
    },
  };
}

function realRollbackReleaseAdapter(): NonNullable<RunReleaseRollbackCommandDeps["release"]> & {
  canary(input: ReleaseRollbackOperationInput): Promise<ReleaseCanaryResult>;
  restoreConfig(input: ReleaseRollbackOperationInput): Promise<ReleaseConfigRestoreResult>;
  activate(input: ReleaseRollbackOperationInput & { restoredConfig: AppConfig }): Promise<ReleaseActivationResult>;
} {
  return {
    async canary(input) {
      return runReleaseCanary({
        config: input.config,
        configPath: input.configPath,
        target: input.target,
      } satisfies ReleaseCanaryOptions);
    },
    async restoreConfig(input) {
      return backupAndRestoreReleaseConfig({
        config: input.config,
        configPath: input.configPath,
        target: input.target,
      } satisfies ReleaseConfigRestoreOptions);
    },
    async activate(input) {
      return activateRelease({
        config: input.restoredConfig,
        target: input.target,
      } satisfies ActivateReleaseOptions);
    },
  };
}

async function recordDeployResult(input: {
  config: AppConfig;
  configPath: string;
  releaseId: string;
  outcome: ReleaseDeployTransitionResult["outcome"] | "failed";
  safety?: DeploySafetyReport;
  transition?: ReleaseDeployTransitionResult;
  errorCode?: string;
}): Promise<void> {
  await recordReleaseDeploy({
    config: input.config,
    configPath: input.configPath,
    releaseId: input.releaseId,
    ...(input.transition?.activation.previousReleaseId ? { previousReleaseId: input.transition.activation.previousReleaseId } : {}),
    outcome: input.outcome,
    safetyStatus: input.safety?.status ?? "unknown",
    safetyReasonCodes: input.safety?.reasons.map((reason) => reason.code) ?? [input.errorCode ?? "transition-error"],
    ...(input.transition ? { currentPath: input.transition.activation.currentPath ?? input.transition.activation.releaseId } : {}),
    ...(input.transition ? { entryPath: input.transition.activation.entryPath ?? input.transition.plist.entryPath } : {}),
    ...(input.transition ? { serviceTarget: input.transition.restart.serviceTarget } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
  });
}

async function recordRollbackResult(input: {
  config: AppConfig;
  configPath: string;
  releaseId: string;
  automatic: boolean;
  result: ReleaseRollbackCommandResult;
}): Promise<void> {
  await recordReleaseRollback({
    config: input.config,
    configPath: input.configPath,
    releaseId: input.releaseId,
    previousReleaseId: "previousReleaseId" in input.result.activation ? input.result.activation.previousReleaseId : undefined,
    automatic: input.automatic,
    backupPath: "backupPath" in input.result.configRestore ? input.result.configRestore.backupPath : undefined,
    currentPath: "currentPath" in input.result.activation ? input.result.activation.currentPath : undefined,
    entryPath: input.result.plist.entryPath,
    serviceTarget: input.result.restart.serviceTarget,
    safetyStatus: input.result.safety.status,
    safetyReasonCodes: input.result.safety.reasons.map((reason) => reason.code),
  });
}

function releaseIdFromActivation(activation: ReleaseRollbackCommandResult["activation"], fallback: string): string {
  if ("release" in activation) return activation.release.releaseId;
  return activation.releaseId || fallback;
}

function elapsedBetween(before: RunControlInspectionSnapshot, after: RunControlInspectionSnapshot): number {
  const beforeMs = Date.parse(before.checkedAt);
  const afterMs = Date.parse(after.checkedAt);
  if (!Number.isFinite(beforeMs) || !Number.isFinite(afterMs)) return 0;
  return Math.max(0, afterMs - beforeMs);
}

function assertSameDataDir(before: AppConfig, after: AppConfig): void {
  if (before.dataDir !== after.dataDir) {
    throw new Error(`Refusing rollback: restored config dataDir ${after.dataDir} differs from active release root ${before.dataDir}`);
  }
}

function resolveProjectRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDir, "..");
}

function formatExecError(error: unknown): string {
  if (error && typeof error === "object") {
    const maybe = error as { stdout?: string; stderr?: string; message?: string; code?: unknown };
    const output = `${maybe.stdout ?? ""}${maybe.stderr ? `\n${maybe.stderr}` : ""}`.trim();
    return output || maybe.message || `exit ${String(maybe.code ?? "unknown")}`;
  }
  return String(error);
}
