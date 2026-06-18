export const STARTUP_RECOVERY_ENV = "PI_DISCORD_THREADS_STARTUP_RECOVERY";

export function startupRecoveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[STARTUP_RECOVERY_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}
