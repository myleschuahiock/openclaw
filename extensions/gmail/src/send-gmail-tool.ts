import { Type } from "@sinclair/typebox";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { sendGmail } from "./send.js";
import type { GmailPluginConfig } from "./types.js";

export function createSendGmailTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "send_gmail",
    label: "Send Gmail",
    description:
      "Send an email, create a draft, or send an existing draft through the Gmail API using the configured OAuth2 Gmail account.",
    parameters: Type.Object({
      to: Type.Optional(Type.Array(Type.String({ description: "To recipients." }))),
      cc: Type.Optional(Type.Array(Type.String({ description: "Cc recipients." }))),
      bcc: Type.Optional(Type.Array(Type.String({ description: "Bcc recipients." }))),
      subject: Type.Optional(Type.String({ description: "Email subject." })),
      text: Type.Optional(Type.String({ description: "Plain text body." })),
      html: Type.Optional(Type.String({ description: "HTML body." })),
      attachments: Type.Optional(
        Type.Array(Type.String({ description: "Absolute or workspace-relative file path." })),
      ),
      reply_to: Type.Optional(Type.String({ description: "Reply-To email address." })),
      from: Type.Optional(Type.String({ description: "From email address." })),
      save_as_draft: Type.Optional(
        Type.Boolean({ description: "Create a Gmail draft instead of sending immediately." }),
      ),
      draft_id: Type.Optional(
        Type.String({ description: "Existing Gmail draft id to send with drafts.send." }),
      ),
    }),
    async execute(_toolCallId, params) {
      const result = await sendGmail(
        params as Record<string, unknown>,
        api.pluginConfig as GmailPluginConfig,
        {
          resolvePath: api.resolvePath,
          logger: api.logger,
        },
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  };
}
