import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createSendGmailTool } from "./src/send-gmail-tool.js";

export { sendGmail, sendGmailWithConfig } from "./src/send.js";
export { createGmailClient, GmailApiClient } from "./src/client.js";
export { buildMimeMessage, encodeRawMessageForGmail } from "./src/mime.js";
export { prepareAttachments } from "./src/attachments.js";
export { assertGmailCredentials, loadGmailRuntimeConfig, parseDotEnv } from "./src/config.js";
export {
  buildAuthorizationUrl,
  codeChallengeS256,
  exchangeAuthorizationCode,
  generateCodeVerifier,
  refreshAccessToken,
} from "./src/oauth.js";
export { executeBridgeRequest, parseBridgeArgs } from "./src/bridge-cli.js";
export {
  DEFAULT_GMAIL_SENDER,
  GMAIL_COMPOSE_SCOPE,
  GMAIL_SEND_SCOPE,
  GmailIntegrationError,
} from "./src/types.js";

const plugin = {
  id: "gmail",
  name: "Gmail",
  description: "Gmail API email sending and draft creation through OAuth2.",
  register(api: OpenClawPluginApi) {
    api.registerTool(createSendGmailTool(api), { name: "send_gmail", optional: true });
  },
};

export default plugin;
