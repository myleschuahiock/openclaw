import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createSendGmailTool } from "./src/send-gmail-tool.js";

export { sendGmail, sendGmailWithConfig } from "./src/send.js";
export { createGmailClient, GmailApiClient } from "./src/client.js";
export { buildMimeMessage, encodeRawMessageForGmail } from "./src/mime.js";
export { prepareAttachments } from "./src/attachments.js";
export { loadGmailRuntimeConfig } from "./src/config.js";

const plugin = {
  id: "gmail",
  name: "Gmail",
  description: "Gmail API email sending and draft creation through OAuth2.",
  register(api: OpenClawPluginApi) {
    api.registerTool(createSendGmailTool(api), { name: "send_gmail", optional: true });
  },
};

export default plugin;
