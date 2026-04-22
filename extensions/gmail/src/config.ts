import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_GMAIL_SENDER,
  GMAIL_API_MAX_RAW_BYTES,
  type GmailPluginConfig,
  type GmailRuntimeConfig,
} from "./types.js";

type EnvMap = Record<string, string | undefined>;

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return fallback;
    }
    return TRUE_VALUES.has(normalized);
  }
  return fallback;
}

function parseNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseDotEnv(raw: string): EnvMap {
  const env: EnvMap = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const idx = trimmed.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      env[key] = unquoteEnvValue(value);
    }
  }
  return env;
}

function resolveMaybePath(
  input: string | undefined,
  resolvePath: ((input: string) => string) | undefined,
): string | undefined {
  const trimmed = input?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (resolvePath) {
    return resolvePath(trimmed);
  }
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(trimmed);
}

function readEnvFile(envFile: string | undefined): EnvMap {
  if (!envFile) {
    return {};
  }
  if (!fs.existsSync(envFile)) {
    return {};
  }
  return parseDotEnv(fs.readFileSync(envFile, "utf8"));
}

export function loadGmailRuntimeConfig(
  pluginConfig: GmailPluginConfig | undefined,
  options: { env?: EnvMap; resolvePath?: (input: string) => string } = {},
): GmailRuntimeConfig {
  const processEnv = options.env ?? process.env;
  const configuredEnvFile =
    typeof pluginConfig?.envFile === "string"
      ? pluginConfig.envFile
      : (processEnv.GMAIL_ENV_FILE ?? "extensions/gmail/.env");
  const envFile = resolveMaybePath(configuredEnvFile, options.resolvePath);
  const fileEnv = readEnvFile(envFile);
  const env = { ...fileEnv, ...processEnv };

  const sender =
    (typeof pluginConfig?.sender === "string" && pluginConfig.sender.trim()) ||
    env.GMAIL_SENDER?.trim() ||
    DEFAULT_GMAIL_SENDER;

  return {
    envFile,
    sender,
    userId:
      (typeof pluginConfig?.userId === "string" && pluginConfig.userId.trim()) ||
      env.GMAIL_USER_ID?.trim() ||
      "me",
    clientId: env.GMAIL_OAUTH_CLIENT_ID?.trim(),
    clientSecret: env.GMAIL_OAUTH_CLIENT_SECRET?.trim(),
    refreshToken: env.GMAIL_OAUTH_REFRESH_TOKEN?.trim(),
    enableDrafts: parseBoolean(pluginConfig?.enableDrafts ?? env.GMAIL_ENABLE_DRAFTS, false),
    allowFromOverride: parseBoolean(
      pluginConfig?.allowFromOverride ?? env.GMAIL_ALLOW_FROM_OVERRIDE,
      false,
    ),
    maxRawBytes: parseNumber(
      pluginConfig?.maxRawBytes ?? env.GMAIL_MAX_RAW_BYTES,
      GMAIL_API_MAX_RAW_BYTES,
    ),
    maxAttachmentBytes:
      pluginConfig?.maxAttachmentBytes !== undefined || env.GMAIL_MAX_ATTACHMENT_BYTES
        ? parseNumber(pluginConfig?.maxAttachmentBytes ?? env.GMAIL_MAX_ATTACHMENT_BYTES, 0)
        : undefined,
    maxRetries: Math.max(
      0,
      Math.trunc(parseNumber(pluginConfig?.maxRetries ?? env.GMAIL_MAX_RETRIES, 3)),
    ),
    retryBaseDelayMs: Math.max(
      50,
      Math.trunc(parseNumber(pluginConfig?.retryBaseDelayMs ?? env.GMAIL_RETRY_BASE_DELAY_MS, 500)),
    ),
  };
}

export function assertGmailCredentials(config: GmailRuntimeConfig): void {
  const missing = [
    ["GMAIL_OAUTH_CLIENT_ID", config.clientId],
    ["GMAIL_OAUTH_REFRESH_TOKEN", config.refreshToken],
  ].filter(([, value]) => !value);

  if (missing.length > 0) {
    const names = missing.map(([name]) => name).join(", ");
    throw new Error(`Missing Gmail OAuth configuration: ${names}`);
  }
}
