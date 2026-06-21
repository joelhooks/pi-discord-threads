import { spawn } from "node:child_process";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig, RunControlRole } from "./config.js";
import { expandPath } from "./config.js";
import { releaseCurrentEntrypoint, releaseCurrentPath } from "./release-snapshots.js";

export const launchAgentLabel = "com.joelhooks.pi-discord-threads";

export interface LaunchAgentOptions {
  config: AppConfig;
  configPath: string;
  roles?: RunControlRole[];
  start: boolean;
  restart: boolean;
  force: boolean;
}

export interface LaunchAgentEntrypoint {
  mode: "release-current" | "repo-dist";
  entryPath: string;
  projectRoot: string;
}

export interface LaunchAgentPaths {
  label: string;
  plistPath: string;
  domain: string;
  serviceTarget: string;
  entryPath: string;
  entryMode: LaunchAgentEntrypoint["mode"];
  projectRoot: string;
  logPath: string;
  errorLogPath: string;
  currentPath: string;
  daemonEntryPaths: string[];
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface WriteLaunchAgentPlistOptions {
  config: AppConfig;
  configPath: string;
  roles?: RunControlRole[];
  paths?: LaunchAgentPaths;
}

export interface WriteLaunchAgentPlistResult {
  paths: LaunchAgentPaths;
  plistPath: string;
  entryPath: string;
}

export interface RestartLaunchAgentOptions {
  config: AppConfig;
  force: boolean;
}

export interface RestartLaunchAgentResult {
  paths: LaunchAgentPaths;
  serviceTarget: string;
}

export async function writeLaunchAgentPlist(options: WriteLaunchAgentPlistOptions): Promise<WriteLaunchAgentPlistResult> {
  const paths = options.paths ?? getLaunchAgentPaths(options.config);
  await mkdir(dirname(paths.plistPath), { recursive: true });
  await mkdir(dirname(paths.logPath), { recursive: true });

  if (!existsSync(paths.entryPath)) {
    throw new Error(`LaunchAgent entrypoint does not exist: ${paths.entryPath}. Run npm run build first.`);
  }

  const configPath = expandPath(options.configPath);
  const plist = renderLaunchAgentPlist(paths, configPath, options.roles);
  await writeFile(paths.plistPath, plist, "utf8");
  return { paths, plistPath: paths.plistPath, entryPath: paths.entryPath };
}

export async function installLaunchAgent(options: LaunchAgentOptions): Promise<void> {
  const { paths } = await writeLaunchAgentPlist({
    config: options.config,
    configPath: options.configPath,
    roles: options.roles,
  });
  const configPath = expandPath(options.configPath);
  console.log(`wrote LaunchAgent: ${paths.plistPath}`);
  console.log(`label: ${paths.label}`);
  console.log(`logs: ${paths.logPath} / ${paths.errorLogPath}`);

  if (!options.start && !options.restart) {
    console.log(`not started; start later with: pi-discord-threads install-launch-agent --start --config ${configPath}`);
    return;
  }

  await startLaunchAgent(paths, options.force, options.restart);
}

export async function restartLaunchAgent(options: RestartLaunchAgentOptions): Promise<RestartLaunchAgentResult> {
  const paths = getLaunchAgentPaths(options.config);
  await startLaunchAgent(paths, options.force, true);
  return { paths, serviceTarget: paths.serviceTarget };
}

export async function uninstallLaunchAgent(config: AppConfig): Promise<void> {
  const paths = getLaunchAgentPaths(config);
  await bootoutLaunchAgent(paths).catch((error) => {
    console.warn(`LaunchAgent was not loaded or could not be booted out: ${error instanceof Error ? error.message : String(error)}`);
  });
  await rm(paths.plistPath, { force: true });
  console.log(`removed LaunchAgent: ${paths.plistPath}`);
}

export async function printLaunchAgentStatus(config: AppConfig): Promise<void> {
  const paths = getLaunchAgentPaths(config);
  console.log(`label: ${paths.label}`);
  console.log(`plist: ${paths.plistPath}${existsSync(paths.plistPath) ? "" : " (missing)"}`);
  console.log(`domain: ${paths.domain}`);
  console.log(`entryMode: ${paths.entryMode}`);
  console.log(`entry: ${paths.entryPath}${existsSync(paths.entryPath) ? "" : " (missing)"}`);
  console.log(`current: ${paths.currentPath}${existsSync(paths.currentPath) ? ` -> ${await readCurrentLink(paths.currentPath)}` : " (missing)"}`);
  const plistProgram = await readPlistProgramArgument(paths.plistPath);
  if (plistProgram) {
    console.log(`plistProgram: ${plistProgram}`);
    if (plistProgram !== paths.entryPath) console.log(`plistProgramMismatch: expected ${paths.entryPath}`);
  }
  console.log(`logs: ${paths.logPath} / ${paths.errorLogPath}`);

  const loaded = await runCommand("launchctl", ["print", paths.serviceTarget]);
  if (loaded.code === 0) {
    console.log("launchctl: loaded");
    const interesting = loaded.stdout
      .split("\n")
      .filter((line) => /state =|pid =|last exit code =|program =|path =|domain =/.test(line))
      .slice(0, 40)
      .join("\n");
    if (interesting.trim()) console.log(interesting);
  } else {
    console.log("launchctl: not loaded");
  }

  const pids = await findExistingDaemonProcesses(paths);
  if (pids.length > 0) {
    console.log("matching daemon process(es):");
    for (const process of pids) console.log(`  ${process}`);
  } else {
    console.log("matching daemon process(es): none");
  }
}

export function resolveLaunchAgentEntrypoint(config: AppConfig): LaunchAgentEntrypoint {
  const currentPath = releaseCurrentPath(config);
  const currentEntryPath = releaseCurrentEntrypoint(config);
  let current;
  try {
    current = lstatSync(currentPath);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (current) {
    if (!current.isSymbolicLink()) {
      throw new Error(`Current release path exists and is not a symlink: ${currentPath}`);
    }
    const releaseTarget = resolve(dirname(currentPath), readlinkSync(currentPath));
    const releasesDir = resolve(dirname(currentPath));
    const relativeTarget = relative(releasesDir, releaseTarget);
    if (!relativeTarget || relativeTarget.startsWith("..") || relativeTarget.startsWith("/")) {
      throw new Error(`Current release symlink escapes release root: ${currentPath} -> ${releaseTarget}`);
    }
    if (!existsSync(join(releaseTarget, "manifest.json"))) {
      throw new Error(`Current release target is missing manifest.json: ${releaseTarget}`);
    }
    return {
      mode: "release-current",
      entryPath: currentEntryPath,
      projectRoot: resolve(dirname(currentEntryPath), ".."),
    };
  }

  const entryPath = resolveEntrypoint();
  return {
    mode: "repo-dist",
    entryPath,
    projectRoot: resolveProjectRoot(entryPath),
  };
}

export function getLaunchAgentPaths(config: AppConfig): LaunchAgentPaths {
  const uid = process.getuid?.() ?? Number(process.env.UID ?? "501");
  const label = launchAgentLabel;
  const plistPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const domain = `gui/${uid}`;
  const serviceTarget = `${domain}/${label}`;
  const entrypoint = resolveLaunchAgentEntrypoint(config);
  const repoEntryPath = resolveEntrypoint();
  const currentEntryPath = releaseCurrentEntrypoint(config);
  return {
    label,
    plistPath,
    domain,
    serviceTarget,
    entryPath: entrypoint.entryPath,
    entryMode: entrypoint.mode,
    projectRoot: entrypoint.projectRoot,
    logPath: join(config.dataDir, "daemon.log"),
    errorLogPath: join(config.dataDir, "daemon.err.log"),
    currentPath: releaseCurrentPath(config),
    daemonEntryPaths: [...new Set([entrypoint.entryPath, repoEntryPath, currentEntryPath])],
  };
}

async function startLaunchAgent(paths: LaunchAgentPaths, force: boolean, restart: boolean): Promise<void> {
  await assertOutsideLaunchAgentDaemon(paths);
  const loaded = await isLaunchAgentLoaded(paths);
  let existingAfterBootout: string[] | undefined;

  if (restart && loaded) {
    await bootoutLaunchAgent(paths);
    existingAfterBootout = await waitForDaemonProcessesToExit(paths);
  }

  const loadedAfterRestart = restart ? false : loaded;
  if (!loadedAfterRestart) {
    const existing = existingAfterBootout ?? await findExistingDaemonProcesses(paths);
    if (existing.length > 0 && !force) {
      throw new Error([
        "Refusing to start LaunchAgent because a non-launchd daemon already appears to be running.",
        "Stop the old daemon after active Discord work is idle, then rerun with --start.",
        "Use --force only if you intentionally want to risk a duplicate Discord bot connection.",
        ...existing.map((process) => `  ${process}`),
      ].join("\n"));
    }

    const bootstrap = await runCommand("launchctl", ["bootstrap", paths.domain, paths.plistPath]);
    if (bootstrap.code !== 0 && !/already exists|already bootstrapped|service is already loaded/i.test(bootstrap.stderr)) {
      throw new Error(`launchctl bootstrap failed: ${bootstrap.stderr.trim() || bootstrap.stdout.trim()}`);
    }
  }

  await runCommand("launchctl", ["enable", paths.serviceTarget]);
  const kickstart = await runCommand("launchctl", ["kickstart", "-k", paths.serviceTarget]);
  if (kickstart.code !== 0) {
    throw new Error(`launchctl kickstart failed: ${kickstart.stderr.trim() || kickstart.stdout.trim()}`);
  }
  console.log(`LaunchAgent running: ${paths.serviceTarget}`);
}

export async function assertOutsideLaunchAgentDaemon(paths: LaunchAgentPaths): Promise<void> {
  if (await isRunningInsideDaemon(paths)) {
    throw new Error([
      "Refusing to start or restart the LaunchAgent from inside the active Discord bridge process tree.",
      "That would SIGTERM the daemon that is currently carrying this Discord turn.",
      "Build and commit the code first, then restart from a terminal after this Discord run is idle.",
    ].join("\n"));
  }
}

async function isLaunchAgentLoaded(paths: LaunchAgentPaths): Promise<boolean> {
  const result = await runCommand("launchctl", ["print", paths.serviceTarget]);
  return result.code === 0;
}

async function bootoutLaunchAgent(paths: LaunchAgentPaths): Promise<void> {
  const byTarget = await runCommand("launchctl", ["bootout", paths.serviceTarget]);
  if (byTarget.code === 0) return;

  const byPlist = await runCommand("launchctl", ["bootout", paths.domain, paths.plistPath]);
  if (byPlist.code !== 0 && !/No such process|Could not find service|not found/i.test(`${byTarget.stderr}\n${byPlist.stderr}`)) {
    throw new Error(byPlist.stderr.trim() || byTarget.stderr.trim() || "launchctl bootout failed");
  }
}

export function renderLaunchAgentPlist(paths: LaunchAgentPaths, configPath: string, roles: RunControlRole[] | undefined): string {
  const args = [process.execPath, paths.entryPath, "start", "--config", configPath];
  if (roles && roles.length > 0) args.push("--roles", roles.join(","));

  const env: Record<string, string> = {
    HOME: homedir(),
    USER: process.env.USER ?? "joel",
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "joel",
    SHELL: process.env.SHELL ?? "/bin/zsh",
    PATH: launchAgentPath(),
  };

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(paths.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${escapeXml(arg)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(paths.projectRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`).join("\n")}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(paths.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(paths.errorLogPath)}</string>
</dict>
</plist>
`;
}

function resolveEntrypoint(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const sibling = join(moduleDir, "index.js");
  if (existsSync(sibling)) return sibling;

  const distFromCwd = resolve(process.cwd(), "dist", "index.js");
  if (existsSync(distFromCwd)) return distFromCwd;

  return sibling;
}

function resolveProjectRoot(entryPath: string): string {
  const fromEntry = resolve(dirname(entryPath), "..");
  if (existsSync(join(fromEntry, "package.json"))) return fromEntry;
  return process.cwd();
}

function launchAgentPath(): string {
  const home = homedir();
  const paths = [
    dirname(process.execPath),
    join(home, ".local", "bin"),
    join(home, ".pi", "agent", "bin"),
    join(home, ".opencode", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".local", "share", "fnm"),
    join(home, "Library", "pnpm"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    join(home, "go", "bin"),
  ];
  return [...new Set(paths)].join(":");
}

async function waitForDaemonProcessesToExit(paths: LaunchAgentPaths, timeoutMs = 5_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let existing = await findExistingDaemonProcesses(paths);
  while (existing.length > 0 && Date.now() < deadline) {
    await sleep(100);
    existing = await findExistingDaemonProcesses(paths);
  }
  return existing;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findExistingDaemonProcesses(paths: LaunchAgentPaths): Promise<string[]> {
  const processes = await listProcesses();
  const currentPid = String(process.pid);
  return processes
    .filter((process) => process.pid !== currentPid)
    .filter((process) => isDaemonCommand(process.command, paths.daemonEntryPaths))
    .map((process) => process.line);
}

async function isRunningInsideDaemon(paths: LaunchAgentPaths): Promise<boolean> {
  const processes = await listProcesses();
  if (processes.length === 0) return false;

  const byPid = new Map(processes.map((process) => [process.pid, process]));
  let parentPid = String(process.ppid);
  const seen = new Set<string>();
  while (parentPid && parentPid !== "0" && !seen.has(parentPid)) {
    seen.add(parentPid);
    const parent = byPid.get(parentPid);
    if (!parent) return false;
    if (isDaemonCommand(parent.command, paths.daemonEntryPaths)) return true;
    parentPid = parent.ppid;
  }
  return false;
}

async function listProcesses(): Promise<Array<{ pid: string; ppid: string; command: string; line: string }>> {
  const result = await runCommand("ps", ["-axo", "pid=,ppid=,command="]);
  if (result.code !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) return [];
      return [{ pid: match[1], ppid: match[2], command: match[3], line }];
    });
}

function isDaemonCommand(command: string, entryPaths: string[]): boolean {
  return entryPaths.some((entryPath) => command.includes(entryPath)) && /\sstart(\s|$)/.test(command);
}

async function readCurrentLink(currentPath: string): Promise<string> {
  try {
    return await readlink(currentPath);
  } catch (error) {
    return error instanceof Error ? `unreadable (${error.message})` : "unreadable";
  }
}

async function readPlistProgramArgument(plistPath: string): Promise<string | undefined> {
  if (!existsSync(plistPath)) return undefined;
  const raw = await readFile(plistPath, "utf8").catch(() => "");
  const strings = [...raw.matchAll(/<string>([^<]+)<\/string>/g)].map((match) => unescapeXml(match[1]));
  return strings.find((value) => value.endsWith("/dist/index.js"));
}

function unescapeXml(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: 127, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
