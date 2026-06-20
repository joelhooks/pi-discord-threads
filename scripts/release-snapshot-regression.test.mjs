import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { defaultConfig, parseCliArgs } from "../dist/config.js";
import {
  createReleaseSnapshot,
  formatReleaseSnapshotList,
  listReleaseSnapshots,
  releaseLedgerPath,
  releaseSnapshotsDir,
} from "../dist/release-snapshots.js";

const execFileAsync = promisify(execFile);

async function run(command, args, options = {}) {
  return execFileAsync(command, args, { maxBuffer: 1024 * 1024, ...options });
}

async function createFixture(options = {}) {
  const ignoreDist = options.ignoreDist === true;
  const distContent = options.distContent ?? "console.log('fixture');\n";
  const projectRoot = await mkdtemp(join(tmpdir(), "pi-discord-release-root-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-discord-release-data-"));
  const configPath = join(dataDir, "config.json");
  const config = defaultConfig();
  config.dataDir = dataDir;
  config.runControl.enabled = true;
  config.runControl.roles = ["bot", "worker", "reconcile"];
  config.runControl.keyPrefix = "pi-discord-test";

  await writeFile(join(projectRoot, "package.json"), `${JSON.stringify({ name: "fixture", version: "1.0.0", type: "module" }, null, 2)}\n`, "utf8");
  await writeFile(join(projectRoot, "package-lock.json"), `${JSON.stringify({ name: "fixture", lockfileVersion: 3, packages: {} }, null, 2)}\n`, "utf8");
  await writeFile(join(projectRoot, "README.md"), "fixture\n", "utf8");
  await writeFile(join(projectRoot, ".gitignore"), ignoreDist ? "dist/\n" : "\n", "utf8");
  await mkdir(join(projectRoot, "dist"), { recursive: true });
  await writeFile(join(projectRoot, "dist", "index.js"), distContent, "utf8");
  await writeFile(configPath, `${JSON.stringify({
    dataDir,
    discord: {
      tokenEnv: "SHOULD_NOT_APPEAR_TOKEN_ENV",
      tokenSecretName: "SHOULD_NOT_APPEAR_SECRET_NAME",
      allowedUserIds: ["SHOULD_NOT_APPEAR_USER_ID"],
    },
    runControl: {
      enabled: true,
      keyPrefix: "pi-discord-test",
      roles: ["bot", "worker", "reconcile"],
    },
  }, null, 2)}\n`, "utf8");
  await chmod(configPath, 0o644);

  await run("git", ["init"], { cwd: projectRoot });
  await run("git", ["checkout", "-b", "main"], { cwd: projectRoot });
  await run("git", ["config", "user.email", "release-test@example.com"], { cwd: projectRoot });
  await run("git", ["config", "user.name", "Release Test"], { cwd: projectRoot });
  await run("git", ["add", "."], { cwd: projectRoot });
  await run("git", ["commit", "-m", "initial"], { cwd: projectRoot });
  const { stdout } = await run("git", ["rev-parse", "--short", "HEAD"], { cwd: projectRoot });

  return { projectRoot, dataDir, configPath, config, shortCommit: stdout.trim() };
}

test("release snapshot writes runnable artifact, safe manifest, private config, digest, and ledger", async () => {
  const fixture = await createFixture();
  try {
    assert.equal((await stat(fixture.configPath)).mode & 0o777, 0o644, "fixture source config should be permissive enough to prove destination mode is forced");

    const result = await createReleaseSnapshot({
      config: fixture.config,
      configPath: fixture.configPath,
      allowDirty: false,
      projectRoot: fixture.projectRoot,
      now: new Date("2026-06-19T15:30:00.000Z"),
    });

    assert.equal(result.releaseId, `20260619T153000Z-${fixture.shortCommit}`);
    assert.equal(result.releasePath, join(fixture.dataDir, "releases", result.releaseId));
    assert.equal(existsSync(join(result.releasePath, "dist", "index.js")), true);
    assert.equal(existsSync(join(result.releasePath, "package.json")), true);
    assert.equal(existsSync(join(result.releasePath, "package-lock.json")), true);
    assert.equal(existsSync(join(result.releasePath, "config.json")), true);
    assert.equal(existsSync(join(result.releasePath, "manifest.json")), true);
    assert.equal(existsSync(join(fixture.dataDir, "releases", "current")), false, "snapshot must not create releases/current");
    assert.equal((await stat(result.releasePath)).mode & 0o777, 0o700);

    const copiedConfig = await readFile(join(result.releasePath, "config.json"), "utf8");
    assert.equal(copiedConfig, await readFile(fixture.configPath, "utf8"));
    assert.equal((await stat(join(result.releasePath, "config.json"))).mode & 0o777, 0o600);

    const manifestRaw = await readFile(join(result.releasePath, "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw);
    assert.equal(manifest.version, 1);
    assert.equal(manifest.releaseId, result.releaseId);
    assert.equal(manifest.shortCommit, fixture.shortCommit);
    assert.equal(manifest.branch, "main");
    assert.equal(manifest.dirty, false);
    assert.equal(manifest.allowDirty, false);
    assert.match(manifest.distSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(manifest.configSummary, {
      dataDir: fixture.dataDir,
      runControlEnabled: true,
      roles: ["bot", "worker", "reconcile"],
      keyPrefix: "pi-discord-test",
    });
    assert.doesNotMatch(manifestRaw, /SHOULD_NOT_APPEAR/);
    assert.doesNotMatch(manifestRaw, /allowedUserIds|tokenSecretName|tokenEnv/);

    const ledgerLines = (await readFile(releaseLedgerPath(fixture.config), "utf8")).trim().split("\n");
    assert.equal(ledgerLines.length, 1);
    const ledger = JSON.parse(ledgerLines[0]);
    assert.equal(ledger.event, "snapshot");
    assert.equal(ledger.releaseId, result.releaseId);
    assert.equal(ledger.distSha256, manifest.distSha256);
    assert.doesNotMatch(ledgerLines[0], /SHOULD_NOT_APPEAR/);
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("release snapshot tightens an existing releases root before private content", async () => {
  const fixture = await createFixture();
  try {
    const releasesDir = releaseSnapshotsDir(fixture.config);
    await mkdir(releasesDir, { recursive: true });
    await chmod(releasesDir, 0o755);
    assert.equal((await stat(releasesDir)).mode & 0o777, 0o755);

    const result = await createReleaseSnapshot({
      config: fixture.config,
      configPath: fixture.configPath,
      allowDirty: false,
      projectRoot: fixture.projectRoot,
      now: new Date("2026-06-19T15:29:00.000Z"),
    });

    assert.equal((await stat(releasesDir)).mode & 0o777, 0o700);
    assert.equal((await stat(result.releasePath)).mode & 0o777, 0o700);
    assert.equal((await stat(join(result.releasePath, "config.json"))).mode & 0o777, 0o600);
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("release snapshot refuses dirty worktree unless allowDirty is explicit", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(join(fixture.projectRoot, "untracked.txt"), "dirty\n", "utf8");

    await assert.rejects(
      () => createReleaseSnapshot({
        config: fixture.config,
        configPath: fixture.configPath,
        allowDirty: false,
        projectRoot: fixture.projectRoot,
        now: new Date("2026-06-19T15:31:00.000Z"),
      }),
      /dirty worktree/,
    );

    const result = await createReleaseSnapshot({
      config: fixture.config,
      configPath: fixture.configPath,
      allowDirty: true,
      projectRoot: fixture.projectRoot,
      now: new Date("2026-06-19T15:31:00.000Z"),
    });

    assert.equal(result.manifest.dirty, true);
    assert.equal(result.manifest.allowDirty, true);
    assert.equal(existsSync(join(result.releasePath, "dist", "index.js")), true);
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("release snapshot collision does not delete existing release", async () => {
  const fixture = await createFixture();
  try {
    const now = new Date("2026-06-19T15:33:00.000Z");
    const first = await createReleaseSnapshot({
      config: fixture.config,
      configPath: fixture.configPath,
      allowDirty: false,
      projectRoot: fixture.projectRoot,
      now,
    });

    await assert.rejects(
      () => createReleaseSnapshot({
        config: fixture.config,
        configPath: fixture.configPath,
        allowDirty: false,
        projectRoot: fixture.projectRoot,
        now,
      }),
      /already exists/,
    );

    assert.equal(existsSync(first.releasePath), true);
    assert.equal(existsSync(join(first.releasePath, "dist", "index.js")), true);
    assert.equal(JSON.parse(await readFile(join(first.releasePath, "manifest.json"), "utf8")).releaseId, first.releaseId);
    const ledgerLines = (await readFile(releaseLedgerPath(fixture.config), "utf8")).trim().split("\n");
    assert.equal(ledgerLines.length, 1);
    assert.equal(JSON.parse(ledgerLines[0]).releaseId, first.releaseId);
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("release snapshot rejects preexisting empty release directory without replacing it", async () => {
  const fixture = await createFixture();
  try {
    const now = new Date("2026-06-19T15:36:00.000Z");
    const releaseId = `20260619T153600Z-${fixture.shortCommit}`;
    const releasesDir = releaseSnapshotsDir(fixture.config);
    const releasePath = join(releasesDir, releaseId);
    await mkdir(releasePath, { recursive: true });
    await chmod(releasePath, 0o755);

    await assert.rejects(
      () => createReleaseSnapshot({
        config: fixture.config,
        configPath: fixture.configPath,
        allowDirty: false,
        projectRoot: fixture.projectRoot,
        now,
      }),
      /already exists/,
    );

    assert.deepEqual(await readdir(releasePath), []);
    assert.equal((await stat(releasePath)).mode & 0o777, 0o755);
    assert.deepEqual((await readdir(releasesDir)).sort(), [releaseId]);
    assert.equal(existsSync(releaseLedgerPath(fixture.config)), false);
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("release snapshot records changed ignored dist artifact without marking git dirty", async () => {
  const fixture = await createFixture({ ignoreDist: true, distContent: "console.log('artifact-v1');\n" });
  try {
    assert.equal((await run("git", ["status", "--porcelain=v1"], { cwd: fixture.projectRoot })).stdout.trim(), "");

    const first = await createReleaseSnapshot({
      config: fixture.config,
      configPath: fixture.configPath,
      allowDirty: false,
      projectRoot: fixture.projectRoot,
      now: new Date("2026-06-19T15:34:00.000Z"),
    });

    await writeFile(join(fixture.projectRoot, "dist", "index.js"), "console.log('artifact-v2');\n", "utf8");
    assert.equal((await run("git", ["status", "--porcelain=v1"], { cwd: fixture.projectRoot })).stdout.trim(), "", "ignored dist change should not mark git dirty");

    const second = await createReleaseSnapshot({
      config: fixture.config,
      configPath: fixture.configPath,
      allowDirty: false,
      projectRoot: fixture.projectRoot,
      now: new Date("2026-06-19T15:35:00.000Z"),
    });

    assert.equal(first.manifest.dirty, false);
    assert.equal(second.manifest.dirty, false);
    assert.match(first.manifest.distSha256, /^[a-f0-9]{64}$/);
    assert.match(second.manifest.distSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(second.manifest.distSha256, first.manifest.distSha256);

    const ledgerLines = (await readFile(releaseLedgerPath(fixture.config), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(ledgerLines.map((entry) => entry.distSha256), [first.manifest.distSha256, second.manifest.distSha256]);

    const listed = await listReleaseSnapshots({ config: fixture.config });
    assert.deepEqual(listed.map((item) => item.distSha256), [second.manifest.distSha256, first.manifest.distSha256]);
    const text = formatReleaseSnapshotList(listed, fixture.config);
    assert.match(text, new RegExp(`distSha256=${second.manifest.distSha256}`));
    assert.match(text, new RegExp(`distSha256=${first.manifest.distSha256}`));
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("release list returns newest-first safe metadata only", async () => {
  const fixture = await createFixture();
  try {
    const older = await createReleaseSnapshot({
      config: fixture.config,
      configPath: fixture.configPath,
      allowDirty: false,
      projectRoot: fixture.projectRoot,
      now: new Date("2026-06-19T15:30:00.000Z"),
    });
    const newer = await createReleaseSnapshot({
      config: fixture.config,
      configPath: fixture.configPath,
      allowDirty: false,
      projectRoot: fixture.projectRoot,
      now: new Date("2026-06-19T15:32:00.000Z"),
    });

    const listed = await listReleaseSnapshots({ config: fixture.config });
    assert.deepEqual(listed.map((item) => item.releaseId), [newer.releaseId, older.releaseId]);
    assert.deepEqual(listed[0].artifactExists, {
      dist: true,
      packageJson: true,
      packageLock: true,
      config: true,
    });
    assert.equal(listed[0].distSha256, newer.manifest.distSha256);
    assert.equal(listed[1].distSha256, older.manifest.distSha256);

    const text = formatReleaseSnapshotList(listed, fixture.config);
    assert.match(text, new RegExp(`${newer.releaseId}[\\s\\S]*${older.releaseId}`));
    assert.match(text, new RegExp(`distSha256=${newer.manifest.distSha256}`));
    assert.match(text, /artifacts=dist:yes,packageJson:yes,packageLock:yes,config:yes/);
    assert.doesNotMatch(text, /SHOULD_NOT_APPEAR/);
    assert.doesNotMatch(text, /tokenSecretName|allowedUserIds|tokenEnv/);
    assert.equal(releaseSnapshotsDir(fixture.config), join(fixture.dataDir, "releases"));
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
    await rm(fixture.dataDir, { recursive: true, force: true });
  }
});

test("release CLI parsing is strict for release subcommands", () => {
  const snapshot = parseCliArgs(["release", "snapshot", "--allow-dirty", "--config", "/tmp/config.json"]);
  assert.equal(snapshot.command, "release");
  assert.equal(snapshot.releaseCommand, "snapshot");
  assert.equal(snapshot.releaseAllowDirty, true);
  assert.equal(snapshot.configPath, "/tmp/config.json");

  const rollback = parseCliArgs(["release", "rollback", "20260619T153000Z-abc1234"]);
  assert.equal(rollback.releaseCommand, "rollback");
  assert.equal(rollback.releaseTarget, "20260619T153000Z-abc1234");

  assert.throws(() => parseCliArgs(["status"]), /Unknown command: status/);
  assert.throws(() => parseCliArgs(["release", "list", "--allow-dirty"]), /only valid for release snapshot/);
  assert.throws(() => parseCliArgs(["release", "snapshot", "--wat"]), /Unknown release option/);
  assert.throws(() => parseCliArgs(["release", "snapshot", "extra"]), /Unexpected release argument/);
  assert.throws(() => parseCliArgs(["release"]), /requires a subcommand/);
});

test("release deploy and rollback reject without LaunchAgent mutation behavior", async () => {
  const distIndex = join(process.cwd(), "dist", "index.js");
  const deploy = await execFileAsync(process.execPath, [distIndex, "release", "deploy"]).then(
    (result) => ({ code: 0, stdout: result.stdout, stderr: result.stderr }),
    (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
  );
  assert.notEqual(deploy.code, 0);
  assert.match(deploy.stderr, /release deploy is not implemented yet/);

  const rollback = await execFileAsync(process.execPath, [distIndex, "release", "rollback", "abc1234"]).then(
    (result) => ({ code: 0, stdout: result.stdout, stderr: result.stderr }),
    (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
  );
  assert.notEqual(rollback.code, 0);
  assert.match(rollback.stderr, /release rollback is not implemented yet/);
});
