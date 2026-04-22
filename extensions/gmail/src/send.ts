import { prepareAttachments } from "./attachments.js";
import { createGmailClient, type GmailApiClient } from "./client.js";
import { loadGmailRuntimeConfig } from "./config.js";
import { buildMimeMessage, encodeRawMessageForGmail } from "./mime.js";
import { normalizeSendGmailInput } from "./recipients.js";
import {
  errorToSendGmailResult,
  type GmailCapability,
  GmailIntegrationError,
  type GmailPluginConfig,
  type GmailRuntimeConfig,
  type SendGmailResult,
} from "./types.js";

type GmailLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

function modeFromParams(params: Record<string, unknown>): SendGmailResult["mode"] {
  if (typeof params.draft_id === "string" && params.draft_id.trim()) {
    return "send_draft";
  }
  return params.save_as_draft === true ? "create_draft" : "send";
}

function assertRuntimeConfig(config: GmailRuntimeConfig): void {
  if (!config.clientId) {
    throw new GmailIntegrationError("MISSING_OAUTH_CONFIG", "GMAIL_OAUTH_CLIENT_ID is required");
  }
  if (!config.refreshToken) {
    throw new GmailIntegrationError(
      "MISSING_OAUTH_CONFIG",
      "GMAIL_OAUTH_REFRESH_TOKEN is required",
    );
  }
}

function requiredCapabilityForMode(mode: SendGmailResult["mode"]): GmailCapability {
  return mode === "send" ? "send" : "drafts";
}

export async function sendGmailWithConfig(
  params: Record<string, unknown>,
  config: GmailRuntimeConfig,
  options: { client?: GmailApiClient; logger?: GmailLogger } = {},
): Promise<SendGmailResult> {
  const requestedMode = modeFromParams(params);
  try {
    assertRuntimeConfig(config);
    const input = normalizeSendGmailInput(params, config);
    const client = options.client ?? createGmailClient(config);
    await client.assertCapability(requiredCapabilityForMode(input.mode));

    if (input.mode === "send_draft") {
      const sent = await client.sendDraft(input.draftId!);
      options.logger?.info?.(
        `gmail: sent draft through Gmail API (messageId=${sent.id ?? "unknown"})`,
      );
      return {
        success: true,
        mode: input.mode,
        message_id: sent.id,
        thread_id: sent.threadId,
      };
    }

    const attachments = await prepareAttachments(input.attachments, {
      maxAttachmentBytes: config.maxAttachmentBytes,
    });
    const mime = buildMimeMessage(input, attachments);
    const raw = encodeRawMessageForGmail(mime, config.maxRawBytes);

    options.logger?.info?.(
      `gmail: ${input.mode === "create_draft" ? "creating draft" : "sending message"} through Gmail API (to=${input.to.length}, cc=${input.cc.length}, bcc=${input.bcc.length}, attachments=${attachments.length}, bytes=${Buffer.byteLength(raw, "utf8")})`,
    );

    if (input.mode === "create_draft") {
      const draft = await client.createDraft(raw);
      return {
        success: true,
        mode: input.mode,
        draft_id: draft.id,
        message_id: draft.message?.id,
        thread_id: draft.message?.threadId,
      };
    }

    const sent = await client.sendRawMessage(raw);
    return {
      success: true,
      mode: input.mode,
      message_id: sent.id,
      thread_id: sent.threadId,
    };
  } catch (error) {
    const result = errorToSendGmailResult(error, requestedMode);
    options.logger?.warn?.(`gmail: request failed (${result.error_code}: ${result.error_message})`);
    return result;
  }
}

export async function sendGmail(
  params: Record<string, unknown>,
  pluginConfig?: GmailPluginConfig,
  options: { resolvePath?: (input: string) => string; logger?: GmailLogger } = {},
): Promise<SendGmailResult> {
  const config = loadGmailRuntimeConfig(pluginConfig, { resolvePath: options.resolvePath });
  return sendGmailWithConfig(params, config, { logger: options.logger });
}
