import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { execFile } from "node:child_process";
import { appendFile, chmod, copyFile, cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";

const execFileAsync = promisify(execFile);
const manifestVersion = 1 as const;
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;

export interface ReleaseSnapshotOptions {
  config: AppConfig;
  configPath: string;
  allowDirty: boolean;
  projectRoot?: string;
  now?: Date;
}

export interface ListReleaseSnapshotsOptions {
  config: AppConfig;
}

export interface ReleaseArtifactFlags {
  dist: boolean;
  packageJson: boolean;
  packageLock: boolean;
  config: boolean;
}

export interface ReleaseConfigSummary {
  dataDir: string;
  runControlEnabled: boolean;
  roles: string[];
  keyPrefix: string;
}

export interface ReleaseSnapshotManifest {
  version: typeof manifestVersion;
  releaseId: string;
  createdAt: string;
  commit: string;
  shortCommit: string;
  branch: string;
  dirty: boolean;
  allowDirty: boolean;
  nodeVersion: string;
  buildCommand: "npm run build";
  configPath: string;
  configSummary: ReleaseConfigSummary;
  distSha256: string;
  artifacts: ReleaseArtifactFlags;
}

export interface ReleaseSnapshotLedgerEntry {
  event: "snapshot";
  version: typeof manifestVersion;
  releaseId: string;
  createdAt: string;
  releasePath: string;
  commit: string;
  shortCommit: string;
  branch: string;
  dirty: boolean;
  allowDirty: boolean;
  configPath: string;
  configSummary: ReleaseConfigSummary;
  distSha256: string;
  artifacts: ReleaseArtifactFlags;
}

export interface ReleaseActivationLedgerEntry {
  event: "activate";
  version: typeof manifestVersion;
  releaseId: string;
  previousReleaseId?: string;
  createdAt: string;
  releasePath: string;
  currentPath: string;
  entryPath: string;
  commit: string;
  shortCommit: string;
  branch: string;
  distSha256: string;
}

export interface ReleaseConfigRestoreLedgerEntry {
  event: "config-restore";
  version: typeof manifestVersion;
  releaseId: string;
  createdAt: string;
  configPath: string;
  backupPath: string;
  releasePath: string;
}

export type ReleaseLedgerEntry = ReleaseSnapshotLedgerEntry | ReleaseActivationLedgerEntry | ReleaseConfigRestoreLedgerEntry;

export interface ReleaseSnapshotResult {
  releaseId: string;
  releasePath: string;
  manifestPath: string;
  ledgerPath: string;
  manifest: ReleaseSnapshotManifest;
}

export interface ResolveReleaseSnapshotOptions {
  config: AppConfig;
  target: string;
}

export interface ResolvedReleaseSnapshot {
  releaseId: string;
  releasePath: string;
  manifestPath: string;
  manifest: ReleaseSnapshotManifest;
}

export interface ActivateReleaseOptions extends ResolveReleaseSnapshotOptions {
  projectRoot?: string;
  now?: Date;
}

export interface ReleaseActivationResult {
  release: ResolvedReleaseSnapshot;
  previousReleaseId?: string;
  currentPath: string;
  entryPath: string;
  nodeModulesLinkPath: string;
  ledgerPath: string;
}

export interface ReleaseConfigRestoreOptions extends ResolveReleaseSnapshotOptions {
  configPath: string;
  now?: Date;
}

export interface ReleaseConfigRestoreResult {
  release: ResolvedReleaseSnapshot;
  configPath: string;
  backupPath: string;
  restoredFrom: string;
  ledgerPath: string;
}

export interface ReleaseCanaryOptions extends ResolveReleaseSnapshotOptions {
  configPath: string;
  projectRoot?: string;
  timeoutMs?: number;
}

export interface ReleaseCanaryResult {
  release: ResolvedReleaseSnapshot;
  entryPath: string;
  distSha256: string;
  doctorOutput: string;
}

export interface ListedReleaseSnapshot extends ReleaseSnapshotLedgerEntry {
  releasePath: string;
  artifactExists: ReleaseArtifactFlags;
}

export async function createReleaseSnapshot(options: ReleaseSnapshotOptions): Promise<ReleaseSnapshotResult> {
  const projectRoot = resolve(options.projectRoot ?? resolveProjectRoot());
  const releasesDir = releaseSnapshotsDir(options.config);
  const ledgerPath = releaseLedgerPath(options.config);
  const configPath = resolve(options.configPath);
  const createdAt = (options.now ?? new Date()).toISOString();

  await assertFile(configPath, "Config file");
  await assertDirectory(join(projectRoot, "dist"), "Built dist directory");
  await assertFile(join(projectRoot, "package.json"), "package.json");
  await assertFile(join(projectRoot, "package-lock.json"), "package-lock.json");

  const git = await readGitState(projectRoot);
  if (git.dirty && !options.allowDirty) {
    throw new Error("Refusing to create release snapshot from a dirty worktree. Commit/stash changes or rerun with --allow-dirty.");
  }

  const releaseId = `${formatReleaseTimestamp(createdAt)}-${git.shortCommit}`;
  const releasePath = join(releasesDir, releaseId);
  const manifestPath = join(releasePath, "manifest.json");
  let tmpRoot: string | undefined;
  let releasePathOwned = false;
  let manifest: ReleaseSnapshotManifest | undefined;

  await mkdir(releasesDir, { recursive: true, mode: privateDirectoryMode });
  await chmod(releasesDir, privateDirectoryMode);
  tmpRoot = await mkdtemp(join(releasesDir, `.tmp-${process.pid}-`));
  await chmod(tmpRoot, privateDirectoryMode);
  const tmpPath = join(tmpRoot, releaseId);

  try {
    await mkdir(tmpPath, { recursive: true, mode: privateDirectoryMode });
    await chmod(tmpPath, privateDirectoryMode);
    await cp(join(projectRoot, "dist"), join(tmpPath, "dist"), { recursive: true, force: false });
    await copyFile(join(projectRoot, "package.json"), join(tmpPath, "package.json"));
    await copyFile(join(projectRoot, "package-lock.json"), join(tmpPath, "package-lock.json"));
    await writePrivateConfigSnapshot(configPath, join(tmpPath, "config.json"));

    const distSha256 = await digestDirectory(join(tmpPath, "dist"));
    manifest = {
      version: manifestVersion,
      releaseId,
      createdAt,
      commit: git.commit,
      shortCommit: git.shortCommit,
      branch: git.branch,
      dirty: git.dirty,
      allowDirty: options.allowDirty,
      nodeVersion: process.version,
      buildCommand: "npm run build",
      configPath,
      configSummary: summarizeConfig(options.config),
      distSha256,
      artifacts: {
        dist: true,
        packageJson: true,
        packageLock: true,
        config: true,
      },
    };
    await writeFile(join(tmpPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });

    try {
      await mkdir(releasePath, { mode: privateDirectoryMode });
      releasePathOwned = true;
      await chmod(releasePath, privateDirectoryMode);
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new Error(`Release snapshot already exists: ${releasePath}`);
      }
      throw error;
    }
    await moveSnapshotArtifacts(tmpPath, releasePath);
  } catch (error) {
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
    if (releasePathOwned) await rm(releasePath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  if (!manifest) {
    throw new Error("Release snapshot manifest was not prepared");
  }

  const ledgerEntry = manifestToLedgerEntry(manifest, releasePath);
  try {
    await appendReleaseLedgerEntry(ledgerPath, ledgerEntry);
  } catch (error) {
    if (releasePathOwned) await rm(releasePath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return {
    releaseId,
    releasePath,
    manifestPath,
    ledgerPath,
    manifest,
  };
}

export async function listReleaseSnapshots(options: ListReleaseSnapshotsOptions): Promise<ListedReleaseSnapshot[]> {
  const releasesDir = releaseSnapshotsDir(options.config);
  const entries = await readLedgerEntries(releaseLedgerPath(options.config));
  const snapshots = entries
    .filter(isReleaseSnapshotLedgerEntry)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.releaseId.localeCompare(a.releaseId));

  return Promise.all(snapshots.map(async (entry) => {
    const releasePath = join(releasesDir, entry.releaseId);
    return {
      ...entry,
      releasePath,
      artifactExists: {
        dist: await exists(join(releasePath, "dist")),
        packageJson: await exists(join(releasePath, "package.json")),
        packageLock: await exists(join(releasePath, "package-lock.json")),
        config: await exists(join(releasePath, "config.json")),
      },
    };
  }));
}

export async function resolveReleaseSnapshot(options: ResolveReleaseSnapshotOptions): Promise<ResolvedReleaseSnapshot> {
  const target = options.target.trim();
  if (!target) throw new Error("Release target is required");
  const releaseTarget = target === "current" ? await requireCurrentReleaseId(options.config) : target;
  const snapshots = (await readLedgerEntries(releaseLedgerPath(options.config))).filter(isReleaseSnapshotLedgerEntry);
  const exact = snapshots.filter((entry) => entry.releaseId === releaseTarget);
  const matches = exact.length > 0 ? exact : snapshots.filter((entry) =>
    entry.releaseId.startsWith(releaseTarget) ||
    entry.shortCommit === releaseTarget ||
    entry.commit === releaseTarget ||
    entry.shortCommit.startsWith(releaseTarget) ||
    entry.commit.startsWith(releaseTarget)
  );

  if (matches.length === 0) throw new Error(`No release snapshot matches: ${target}`);
  const uniqueByReleaseId = [...new Map(matches.map((entry) => [entry.releaseId, entry])).values()];
  if (uniqueByReleaseId.length > 1) {
    throw new Error(`Release target is ambiguous: ${target} matches ${uniqueByReleaseId.map((entry) => entry.releaseId).join(", ")}`);
  }

  const snapshot = uniqueByReleaseId[0];
  const releasesDir = releaseSnapshotsDir(options.config);
  const releasePath = join(releasesDir, snapshot.releaseId);
  assertPathInside(releasesDir, releasePath, "release snapshot");
  const manifestPath = join(releasePath, "manifest.json");
  const manifest = await readReleaseManifest(manifestPath);
  if (manifest.releaseId !== snapshot.releaseId) {
    throw new Error(`Release manifest id mismatch: ${manifest.releaseId} !== ${snapshot.releaseId}`);
  }
  if (manifest.version !== manifestVersion) {
    throw new Error(`Unsupported release manifest version: ${manifest.version}`);
  }

  return {
    releaseId: snapshot.releaseId,
    releasePath,
    manifestPath,
    manifest,
  };
}

export async function activateRelease(options: ActivateReleaseOptions): Promise<ReleaseActivationResult> {
  const release = await resolveReleaseSnapshot(options);
  await assertReleaseRunnable(release);
  await assertReleaseDistDigest(release);
  const projectRoot = resolve(options.projectRoot ?? resolveProjectRoot());
  const nodeModulesLinkPath = await ensureReleaseNodeModulesLink({ config: options.config, projectRoot });
  const previousReleaseId = await readCurrentReleaseId(options.config);
  const currentPath = releaseCurrentPath(options.config);
  await writeCurrentReleaseSymlink(options.config, release.releaseId);
  const ledgerPath = releaseLedgerPath(options.config);
  await appendReleaseLedgerEntry(ledgerPath, {
    event: "activate",
    version: manifestVersion,
    releaseId: release.releaseId,
    ...(previousReleaseId ? { previousReleaseId } : {}),
    createdAt: (options.now ?? new Date()).toISOString(),
    releasePath: release.releasePath,
    currentPath,
    entryPath: releaseCurrentEntrypoint(options.config),
    commit: release.manifest.commit,
    shortCommit: release.manifest.shortCommit,
    branch: release.manifest.branch,
    distSha256: release.manifest.distSha256,
  });

  return {
    release,
    ...(previousReleaseId ? { previousReleaseId } : {}),
    currentPath,
    entryPath: releaseCurrentEntrypoint(options.config),
    nodeModulesLinkPath,
    ledgerPath,
  };
}

export async function backupAndRestoreReleaseConfig(options: ReleaseConfigRestoreOptions): Promise<ReleaseConfigRestoreResult> {
  const release = await resolveReleaseSnapshot(options);
  await assertReleaseRunnable(release);
  const configPath = resolve(options.configPath);
  const manifestConfigPath = resolve(release.manifest.configPath);
  if (manifestConfigPath !== configPath) {
    throw new Error(`Refusing to restore config: release manifest configPath ${manifestConfigPath} does not match requested --config ${configPath}`);
  }

  const releaseConfigPath = join(release.releasePath, "config.json");
  await assertFile(configPath, "Current config file");
  await assertFile(releaseConfigPath, "Release config snapshot");
  const timestamp = formatReleaseTimestamp((options.now ?? new Date()).toISOString());
  const backupPath = await writeExclusiveConfigBackup(configPath, timestamp);
  const tmpPath = join(dirname(configPath), `.${basename(configPath)}.restore-${process.pid}-${timestamp}`);
  try {
    await copyFile(releaseConfigPath, tmpPath);
    await chmod(tmpPath, privateFileMode);
    await rename(tmpPath, configPath);
    await chmod(configPath, privateFileMode);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }

  const ledgerPath = releaseLedgerPath(options.config);
  await appendReleaseLedgerEntry(ledgerPath, {
    event: "config-restore",
    version: manifestVersion,
    releaseId: release.releaseId,
    createdAt: (options.now ?? new Date()).toISOString(),
    configPath,
    backupPath,
    releasePath: release.releasePath,
  });

  return {
    release,
    configPath,
    backupPath,
    restoredFrom: releaseConfigPath,
    ledgerPath,
  };
}

export async function runReleaseCanary(options: ReleaseCanaryOptions): Promise<ReleaseCanaryResult> {
  const release = await resolveReleaseSnapshot(options);
  await assertReleaseRunnable(release);
  await ensureReleaseNodeModulesLink({ config: options.config, projectRoot: resolve(options.projectRoot ?? resolveProjectRoot()) });
  const actualDistSha256 = await assertReleaseDistDigest(release);

  const entryPath = join(release.releasePath, "dist", "index.js");
  const configPath = resolve(options.configPath);
  try {
    const result = await execFileAsync(process.execPath, [entryPath, "doctor", "--config", configPath], {
      cwd: release.releasePath,
      timeout: options.timeoutMs ?? 15_000,
      maxBuffer: 512 * 1024,
    });
    return {
      release,
      entryPath,
      distSha256: actualDistSha256,
      doctorOutput: clampOutput(`${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`),
    };
  } catch (error) {
    const details = formatExecError(error);
    throw new Error(`Release canary failed for ${release.releaseId}: ${details}`);
  }
}

export function formatReleaseSnapshotResult(result: ReleaseSnapshotResult): string {
  return [
    `release snapshot: ${result.releaseId}`,
    `path: ${result.releasePath}`,
    `manifest: ${result.manifestPath}`,
    `ledger: ${result.ledgerPath}`,
    `commit: ${result.manifest.shortCommit}`,
    `branch: ${result.manifest.branch}`,
    `dirty: ${String(result.manifest.dirty)}`,
    `distSha256: ${result.manifest.distSha256}`,
  ].join("\n");
}

export function formatReleaseActivationResult(result: ReleaseActivationResult): string {
  return [
    `release activate: ${result.release.releaseId}`,
    `previous: ${result.previousReleaseId ?? "(none)"}`,
    `current: ${result.currentPath}`,
    `entry: ${result.entryPath}`,
    `nodeModules: ${result.nodeModulesLinkPath}`,
    `distSha256: ${result.release.manifest.distSha256}`,
    "launchctl: not called",
  ].join("\n");
}

export function formatReleaseConfigRestoreResult(result: ReleaseConfigRestoreResult): string {
  return [
    `release config restore: ${result.release.releaseId}`,
    `config: ${result.configPath}`,
    `backup: ${result.backupPath}`,
    `restoredFrom: ${result.restoredFrom}`,
    `launchctl: not called`,
  ].join("\n");
}

export function formatReleaseCanaryResult(result: ReleaseCanaryResult): string {
  return [
    `release canary: ${result.release.releaseId}`,
    `entry: ${result.entryPath}`,
    `distSha256: ${result.distSha256}`,
    "doctor:",
    result.doctorOutput || "(no output)",
  ].join("\n");
}

export function formatReleaseSnapshotList(snapshots: ListedReleaseSnapshot[], config: AppConfig): string {
  if (snapshots.length === 0) {
    return `No release snapshots found in ${releaseSnapshotsDir(config)}`;
  }

  const lines = [`Release snapshots in ${releaseSnapshotsDir(config)}:`];
  for (const snapshot of snapshots) {
    lines.push([
      snapshot.releaseId,
      `created=${snapshot.createdAt}`,
      `commit=${snapshot.shortCommit}`,
      `branch=${snapshot.branch}`,
      `dirty=${String(snapshot.dirty)}`,
      `config=${snapshot.configPath}`,
      `distSha256=${snapshot.distSha256}`,
      `artifacts=dist:${yesNo(snapshot.artifactExists.dist)},packageJson:${yesNo(snapshot.artifactExists.packageJson)},packageLock:${yesNo(snapshot.artifactExists.packageLock)},config:${yesNo(snapshot.artifactExists.config)}`,
    ].join(" "));
  }
  return lines.join("\n");
}

export function releaseSnapshotsDir(config: AppConfig): string {
  return join(config.dataDir, "releases");
}

export function releaseLedgerPath(config: AppConfig): string {
  return join(releaseSnapshotsDir(config), "ledger.jsonl");
}

export function releaseCurrentPath(config: AppConfig): string {
  return join(releaseSnapshotsDir(config), "current");
}

export function releaseCurrentEntrypoint(config: AppConfig): string {
  return join(releaseCurrentPath(config), "dist", "index.js");
}

function summarizeConfig(config: AppConfig): ReleaseConfigSummary {
  return {
    dataDir: config.dataDir,
    runControlEnabled: config.runControl.enabled,
    roles: [...config.runControl.roles],
    keyPrefix: config.runControl.keyPrefix,
  };
}

function manifestToLedgerEntry(manifest: ReleaseSnapshotManifest, releasePath: string): ReleaseSnapshotLedgerEntry {
  return {
    event: "snapshot",
    version: manifest.version,
    releaseId: manifest.releaseId,
    createdAt: manifest.createdAt,
    releasePath,
    commit: manifest.commit,
    shortCommit: manifest.shortCommit,
    branch: manifest.branch,
    dirty: manifest.dirty,
    allowDirty: manifest.allowDirty,
    configPath: manifest.configPath,
    configSummary: manifest.configSummary,
    distSha256: manifest.distSha256,
    artifacts: manifest.artifacts,
  };
}

async function moveSnapshotArtifacts(sourcePath: string, releasePath: string): Promise<void> {
  const artifactNames = ["dist", "package.json", "package-lock.json", "config.json", "manifest.json"] as const;
  for (const artifactName of artifactNames) {
    await rename(join(sourcePath, artifactName), join(releasePath, artifactName));
  }
}

async function writePrivateConfigSnapshot(sourcePath: string, destinationPath: string): Promise<void> {
  const configBytes = await readFile(sourcePath);
  await writeFile(destinationPath, configBytes, { mode: privateFileMode });
  await chmod(destinationPath, privateFileMode);
}

async function readLedgerEntries(ledgerPath: string): Promise<ReleaseLedgerEntry[]> {
  let raw: string;
  try {
    raw = await readFile(ledgerPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }

  const entries: ReleaseLedgerEntry[] = [];
  for (const [index, line] of raw.split("\n").entries()) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as Partial<ReleaseLedgerEntry>;
    if (parsed.version !== manifestVersion || !parsed.event || !parsed.createdAt) {
      throw new Error(`Invalid release ledger entry at ${ledgerPath}:${index + 1}`);
    }
    if (parsed.event === "snapshot") {
      if (!parsed.releaseId || !parsed.releasePath || !parsed.shortCommit || !parsed.commit) {
        throw new Error(`Invalid release snapshot ledger entry at ${ledgerPath}:${index + 1}`);
      }
      entries.push({
        ...(parsed as ReleaseSnapshotLedgerEntry),
        distSha256: typeof parsed.distSha256 === "string" && parsed.distSha256.length > 0 ? parsed.distSha256 : "unknown",
      });
      continue;
    }
    if (parsed.event === "activate") {
      if (!parsed.releaseId || !parsed.releasePath || !parsed.currentPath || !parsed.entryPath) {
        throw new Error(`Invalid release activation ledger entry at ${ledgerPath}:${index + 1}`);
      }
      entries.push(parsed as ReleaseActivationLedgerEntry);
      continue;
    }
    if (parsed.event === "config-restore") {
      if (!parsed.releaseId || !parsed.configPath || !parsed.backupPath || !parsed.releasePath) {
        throw new Error(`Invalid release config restore ledger entry at ${ledgerPath}:${index + 1}`);
      }
      entries.push(parsed as ReleaseConfigRestoreLedgerEntry);
      continue;
    }
    throw new Error(`Unknown release ledger event at ${ledgerPath}:${index + 1}`);
  }
  return entries;
}

function isReleaseSnapshotLedgerEntry(entry: ReleaseLedgerEntry): entry is ReleaseSnapshotLedgerEntry {
  return entry.event === "snapshot";
}

async function appendReleaseLedgerEntry(ledgerPath: string, entry: ReleaseLedgerEntry): Promise<void> {
  await appendFile(ledgerPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: privateFileMode });
  await chmod(ledgerPath, privateFileMode);
}

async function readReleaseManifest(manifestPath: string): Promise<ReleaseSnapshotManifest> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ReleaseSnapshotManifest;
  if (!manifest.releaseId || !manifest.commit || !manifest.shortCommit || !manifest.configPath || !manifest.distSha256) {
    throw new Error(`Invalid release manifest: ${manifestPath}`);
  }
  return manifest;
}

async function assertReleaseRunnable(release: ResolvedReleaseSnapshot): Promise<void> {
  await assertDirectory(join(release.releasePath, "dist"), "Release dist directory");
  await assertFile(join(release.releasePath, "dist", "index.js"), "Release entrypoint");
  await assertFile(join(release.releasePath, "package.json"), "Release package.json");
  await assertFile(join(release.releasePath, "package-lock.json"), "Release package-lock.json");
  await assertFile(join(release.releasePath, "config.json"), "Release config snapshot");
}

async function assertReleaseDistDigest(release: ResolvedReleaseSnapshot): Promise<string> {
  const actualDistSha256 = await digestDirectory(join(release.releasePath, "dist"));
  if (actualDistSha256 !== release.manifest.distSha256) {
    throw new Error(`Release dist digest mismatch for ${release.releaseId}: manifest=${release.manifest.distSha256} actual=${actualDistSha256}`);
  }
  return actualDistSha256;
}

async function writeExclusiveConfigBackup(configPath: string, timestamp: string): Promise<string> {
  const basePath = join(dirname(configPath), `${basename(configPath)}.backup-${timestamp}`);
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = attempt === 0 ? basePath : `${basePath}-${attempt}`;
    try {
      await copyFile(configPath, candidate, fsConstants.COPYFILE_EXCL);
      await chmod(candidate, privateFileMode);
      return candidate;
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error(`Unable to reserve unique config backup path for ${configPath}`);
}

async function ensureReleaseNodeModulesLink(options: { config: AppConfig; projectRoot: string }): Promise<string> {
  const releasesDir = releaseSnapshotsDir(options.config);
  await mkdir(releasesDir, { recursive: true, mode: privateDirectoryMode });
  await chmod(releasesDir, privateDirectoryMode);
  const nodeModulesTarget = join(options.projectRoot, "node_modules");
  await assertDirectory(nodeModulesTarget, "Project node_modules directory");
  const linkPath = join(releasesDir, "node_modules");

  try {
    const existing = await lstat(linkPath);
    if (!existing.isSymbolicLink()) {
      throw new Error(`Release node_modules path exists and is not a symlink: ${linkPath}`);
    }
    const linkTarget = await readlink(linkPath);
    const resolvedLinkTarget = resolve(dirname(linkPath), linkTarget);
    if (resolvedLinkTarget !== resolve(nodeModulesTarget)) {
      throw new Error(`Release node_modules symlink points at ${resolvedLinkTarget}, expected ${resolve(nodeModulesTarget)}`);
    }
    return linkPath;
  } catch (error) {
    if (!(isNodeError(error) && error.code === "ENOENT")) throw error;
  }

  await symlink(nodeModulesTarget, linkPath, "dir");
  return linkPath;
}

async function requireCurrentReleaseId(config: AppConfig): Promise<string> {
  const current = await readCurrentReleaseId(config);
  if (!current) throw new Error(`No current release symlink found: ${releaseCurrentPath(config)}`);
  return current;
}

async function readCurrentReleaseId(config: AppConfig): Promise<string | undefined> {
  const currentPath = releaseCurrentPath(config);
  try {
    const current = await lstat(currentPath);
    if (!current.isSymbolicLink()) throw new Error(`Current release path exists and is not a symlink: ${currentPath}`);
    return basename(await readlink(currentPath));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeCurrentReleaseSymlink(config: AppConfig, releaseId: string): Promise<void> {
  const releasesDir = releaseSnapshotsDir(config);
  await mkdir(releasesDir, { recursive: true, mode: privateDirectoryMode });
  await chmod(releasesDir, privateDirectoryMode);
  const currentPath = releaseCurrentPath(config);
  try {
    const current = await lstat(currentPath);
    if (!current.isSymbolicLink()) throw new Error(`Current release path exists and is not a symlink: ${currentPath}`);
  } catch (error) {
    if (!(isNodeError(error) && error.code === "ENOENT")) throw error;
  }

  const tmpPath = join(releasesDir, `.current.tmp-${process.pid}-${Date.now()}`);
  try {
    await symlink(releaseId, tmpPath, "dir");
    await rename(tmpPath, currentPath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function assertPathInside(rootPath: string, candidatePath: string, label: string): void {
  const relativePath = relative(resolve(rootPath), resolve(candidatePath));
  if (!relativePath || relativePath.startsWith("..") || relativePath.startsWith("/")) {
    throw new Error(`${label} path escapes release root: ${candidatePath}`);
  }
}

function clampOutput(value: string): string {
  const lines = value.trim().split("\n").slice(0, 80);
  const text = lines.join("\n");
  return text.length > 20_000 ? `${text.slice(0, 20_000)}\n… truncated …` : text;
}

function formatExecError(error: unknown): string {
  if (error && typeof error === "object") {
    const maybe = error as { code?: unknown; signal?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown };
    const code = maybe.code === undefined ? "unknown" : String(maybe.code);
    const signal = maybe.signal === undefined ? "none" : String(maybe.signal);
    const output = clampOutput(`${typeof maybe.stdout === "string" ? maybe.stdout : ""}${typeof maybe.stderr === "string" ? `\n${maybe.stderr}` : ""}`);
    return `exit=${code} signal=${signal}${output ? ` output=${JSON.stringify(output)}` : ""}`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function readGitState(projectRoot: string): Promise<{ commit: string; shortCommit: string; branch: string; dirty: boolean }> {
  const [commit, shortCommit, branchName, status] = await Promise.all([
    runGit(projectRoot, ["rev-parse", "HEAD"]),
    runGit(projectRoot, ["rev-parse", "--short", "HEAD"]),
    runGit(projectRoot, ["branch", "--show-current"]),
    runGit(projectRoot, ["status", "--porcelain=v1"]),
  ]);

  return {
    commit,
    shortCommit,
    branch: branchName || "detached",
    dirty: status.trim().length > 0,
  };
}

async function runGit(projectRoot: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: projectRoot, maxBuffer: 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(" ")} failed in ${projectRoot}: ${message}`);
  }
}

async function digestDirectory(rootPath: string): Promise<string> {
  const hash = createHash("sha256");
  const entries = await listDigestEntries(rootPath, rootPath);
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  for (const entry of entries) {
    hash.update(entry.kind);
    hash.update("\0");
    hash.update(entry.relativePath);
    hash.update("\0");
    hash.update(entry.bytes);
    hash.update("\0");
  }

  return hash.digest("hex");
}

async function listDigestEntries(rootPath: string, directoryPath: string): Promise<Array<{ kind: "file" | "symlink"; relativePath: string; bytes: Buffer }>> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const digestEntries: Array<{ kind: "file" | "symlink"; relativePath: string; bytes: Buffer }> = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolutePath = join(directoryPath, entry.name);
    const relativePath = relative(rootPath, absolutePath).split("\\").join("/");
    if (entry.isDirectory()) {
      digestEntries.push(...await listDigestEntries(rootPath, absolutePath));
      continue;
    }
    if (entry.isFile()) {
      digestEntries.push({ kind: "file", relativePath, bytes: await readFile(absolutePath) });
      continue;
    }
    if (entry.isSymbolicLink()) {
      digestEntries.push({ kind: "symlink", relativePath, bytes: Buffer.from(await readlink(absolutePath), "utf8") });
    }
  }

  return digestEntries;
}

function resolveProjectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function formatReleaseTimestamp(isoTimestamp: string): string {
  return isoTimestamp.replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

async function assertFile(path: string, label: string): Promise<void> {
  let value;
  try {
    value = await stat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`${label} does not exist: ${path}`);
    }
    throw error;
  }
  if (!value.isFile()) throw new Error(`${label} is not a file: ${path}`);
}

async function assertDirectory(path: string, label: string): Promise<void> {
  let value;
  try {
    value = await stat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`${label} does not exist: ${path}`);
    }
    throw error;
  }
  if (!value.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function yesNo(value: boolean): "yes" | "no" {
  return value ? "yes" : "no";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
