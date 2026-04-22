import { loadGmailRuntimeConfig } from "./config.js";
import { refreshAccessToken } from "./oauth.js";
import { capabilitySatisfied, formatGrantedScopes } from "./scopes.js";
import { sendGmail } from "./send.js";
import {
  errorToSendGmailResult,
  type GmailCapability,
  GmailIntegrationError,
  type GmailPluginConfig,
} from "./types.js";

export type GmailBridgeMode = "send" | "healthcheck";

export type GmailBridgeArgs = {
  mode: GmailBridgeMode;
  envFile?: string;
  capability: GmailCapability;
};

export type GmailBridgeSuccess = {
  success: true;
  mode: GmailBridgeMode;
  sender?: string;
  scope?: string;
  granted_scopes?: string[];
  expires_at?: string;
  required_capability?: GmailCapability;
  capability_satisfied?: boolean | null;
  scope_source?: "token_response" | "configured_hint" | "unknown";
  result?: unknown;
};

export type GmailBridgeFailure = {
  success: false;
  mode: GmailBridgeMode;
  error_code: string;
  error_message: string;
  retryable?: boolean;
};

export type GmailBridgeOutput = GmailBridgeSuccess | GmailBridgeFailure;

function usage(): string {
  return [
    "Usage:",
    "  tsx extensions/gmail/scripts/bridge.ts --mode healthcheck --capability send --env extensions/gmail/.env",
    "  tsx extensions/gmail/scripts/bridge.ts --mode send --env extensions/gmail/.env < payload.json",
  ].join("\n");
}

export function parseBridgeArgs(argv: string[]): GmailBridgeArgs {
  const args: GmailBridgeArgs = { mode: "send", capability: "send" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i] ?? "";
    if (arg === "--mode") {
      const mode = next();
      if (mode !== "send" && mode !== "healthcheck") {
        throw new GmailIntegrationError("INVALID_ARGUMENT", "--mode must be send or healthcheck");
      }
      args.mode = mode;
    } else if (arg === "--env") {
      args.envFile = next();
    } else if (arg === "--capability") {
      const capability = next();
      if (capability !== "send" && capability !== "drafts") {
        throw new GmailIntegrationError("INVALID_ARGUMENT", "--capability must be send or drafts");
      }
      args.capability = capability;
    } else if (arg === "--help" || arg === "-h") {
      throw new GmailIntegrationError("HELP", usage());
    } else {
      throw new GmailIntegrationError("INVALID_ARGUMENT", `Unknown argument: ${arg}`);
    }
  }
  return args;
}

function parsePayload(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new GmailIntegrationError("INVALID_PAYLOAD", "JSON payload is required on stdin");
  }
  try {
    const payload = JSON.parse(trimmed) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("payload must be an object");
    }
    return payload as Record<string, unknown>;
  } catch (error) {
    throw new GmailIntegrationError(
      "INVALID_PAYLOAD",
      error instanceof Error ? error.message : "Invalid JSON payload",
    );
  }
}

function pluginConfig(args: GmailBridgeArgs): GmailPluginConfig {
  return args.envFile ? { envFile: args.envFile } : {};
}

export async function executeBridgeRequest(
  args: GmailBridgeArgs,
  stdin: string,
): Promise<GmailBridgeOutput> {
  if (args.mode === "healthcheck") {
    try {
      const config = loadGmailRuntimeConfig(pluginConfig(args));
      const token = await refreshAccessToken(config);
      const supported = capabilitySatisfied(args.capability, token.grantedScopes);
      if (supported === false) {
        return {
          success: false,
          mode: "healthcheck",
          error_code: "SCOPE_INSUFFICIENT",
          error_message: `Gmail OAuth token does not grant ${args.capability} capability. Granted scopes: ${formatGrantedScopes(token.grantedScopes)}`,
          retryable: false,
        };
      }
      return {
        success: true,
        mode: "healthcheck",
        sender: config.sender,
        scope: token.scope,
        granted_scopes: token.grantedScopes,
        expires_at: new Date(token.expiresAt).toISOString(),
        required_capability: args.capability,
        capability_satisfied: supported,
        scope_source: token.scopeSource,
      };
    } catch (error) {
      const result = errorToSendGmailResult(error, "send");
      return {
        success: false,
        mode: "healthcheck",
        error_code: result.error_code ?? "UNKNOWN_ERROR",
        error_message: result.error_message ?? "Gmail API healthcheck failed",
        retryable: result.retryable,
      };
    }
  }

  try {
    const params = parsePayload(stdin);
    const result = await sendGmail(params, pluginConfig(args));
    if (!result.success) {
      return {
        success: false,
        mode: "send",
        error_code: result.error_code ?? "GMAIL_SEND_FAILED",
        error_message: result.error_message ?? "Gmail API send failed",
        retryable: result.retryable,
      };
    }
    return { success: true, mode: "send", result };
  } catch (error) {
    const result = errorToSendGmailResult(error, "send");
    return {
      success: false,
      mode: "send",
      error_code: result.error_code ?? "UNKNOWN_ERROR",
      error_message: result.error_message ?? "Gmail API send failed",
      retryable: result.retryable,
    };
  }
}
