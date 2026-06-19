import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFile, chmod, copyFile, cp, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
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

export interface ReleaseLedgerEntry {
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

export interface ReleaseSnapshotResult {
  releaseId: string;
  releasePath: string;
  manifestPath: string;
  ledgerPath: string;
  manifest: ReleaseSnapshotManifest;
}

export interface ListedReleaseSnapshot extends ReleaseLedgerEntry {
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
    await appendFile(ledgerPath, `${JSON.stringify(ledgerEntry)}\n`, { encoding: "utf8", mode: privateFileMode });
    await chmod(ledgerPath, privateFileMode);
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
    .filter((entry) => entry.event === "snapshot")
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

function summarizeConfig(config: AppConfig): ReleaseConfigSummary {
  return {
    dataDir: config.dataDir,
    runControlEnabled: config.runControl.enabled,
    roles: [...config.runControl.roles],
    keyPrefix: config.runControl.keyPrefix,
  };
}

function manifestToLedgerEntry(manifest: ReleaseSnapshotManifest, releasePath: string): ReleaseLedgerEntry {
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
    const parsed = JSON.parse(line) as ReleaseLedgerEntry;
    if (parsed.version !== manifestVersion || parsed.event !== "snapshot" || !parsed.releaseId || !parsed.createdAt) {
      throw new Error(`Invalid release ledger entry at ${ledgerPath}:${index + 1}`);
    }
    entries.push({
      ...parsed,
      distSha256: typeof parsed.distSha256 === "string" && parsed.distSha256.length > 0 ? parsed.distSha256 : "unknown",
    });
  }
  return entries;
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
