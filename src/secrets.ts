import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SecretResolverOptions {
  command?: string;
  clientId?: string;
}

export class SecretResolver {
  private readonly command: string;
  private readonly clientId: string;

  constructor(options: SecretResolverOptions = {}) {
    this.command = options.command ?? "secrets";
    this.clientId = options.clientId ?? "pi-discord-threads";
  }

  getEnv(name: string | undefined): string | undefined {
    if (!name) return undefined;
    const value = process.env[name];
    return value && value.length > 0 ? value : undefined;
  }

  async lease(name: string, ttl: string): Promise<string> {
    const { stdout } = await execFileAsync(this.command, [
      "lease",
      name,
      "--ttl",
      ttl,
      "--client-id",
      this.clientId,
    ], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  }

  async optionalLease(name: string | undefined, ttl: string): Promise<string | undefined> {
    if (!name) return undefined;
    try {
      const value = await this.lease(name, ttl);
      return value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  async resolveRequired(options: {
    envName?: string;
    secretName?: string;
    ttl: string;
    label: string;
  }): Promise<string> {
    const fromEnv = this.getEnv(options.envName);
    if (fromEnv) return fromEnv;

    if (options.secretName) {
      try {
        const value = await this.lease(options.secretName, options.ttl);
        if (value.length > 0) return value;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to lease ${options.label} secret '${options.secretName}': ${message}`);
      }
    }

    throw new Error(
      `Missing ${options.label}. Set ${options.envName ?? "an env var"}` +
        (options.secretName ? ` or add local secret '${options.secretName}'.` : "."),
    );
  }

  async resolveOptional(options: {
    envName?: string;
    secretName?: string;
    ttl: string;
  }): Promise<string | undefined> {
    const fromEnv = this.getEnv(options.envName);
    if (fromEnv) return fromEnv;
    return this.optionalLease(options.secretName, options.ttl);
  }
}
