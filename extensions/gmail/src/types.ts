export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export const MAIL_GOOGLE_SCOPE = "https://mail.google.com/";
export const GMAIL_API_MAX_RAW_BYTES = 36_700_160;
export const DEFAULT_GMAIL_SENDER = "miaibarra.bh@gmail.com";

export type GmailMode = "send" | "create_draft" | "send_draft";
export type GmailCapability = "send" | "drafts";

export type GmailPluginConfig = {
  envFile?: string;
  sender?: string;
  userId?: string;
  enableDrafts?: boolean;
  allowFromOverride?: boolean;
  grantedScopesHint?: string[];
  maxRawBytes?: number;
  maxAttachmentBytes?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  httpTimeoutMs?: number;
};

export type GmailRuntimeConfig = Required<
  Pick<
    GmailPluginConfig,
    | "sender"
    | "userId"
    | "enableDrafts"
    | "allowFromOverride"
    | "maxRawBytes"
    | "maxRetries"
    | "retryBaseDelayMs"
    | "httpTimeoutMs"
  >
> & {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  envFile?: string;
  grantedScopesHint: string[];
  maxAttachmentBytes?: number;
};

export type SendGmailInput = {
  to?: unknown;
  cc?: unknown;
  bcc?: unknown;
  subject?: unknown;
  text?: unknown;
  html?: unknown;
  attachments?: unknown;
  reply_to?: unknown;
  from?: unknown;
  save_as_draft?: unknown;
  draft_id?: unknown;
};

export type NormalizedSendGmailInput = {
  mode: GmailMode;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments: string[];
  replyTo?: string;
  draftId?: string;
};

export type PreparedAttachment = {
  path: string;
  filename: string;
  contentType: string;
  size: number;
  content: Buffer;
};

export type GmailMessageResponse = {
  id?: string;
  threadId?: string;
};

export type GmailDraftResponse = {
  id?: string;
  message?: GmailMessageResponse;
};

export type SendGmailResult = {
  success: boolean;
  mode: GmailMode;
  message_id?: string;
  draft_id?: string;
  thread_id?: string;
  error_code?: string;
  error_message?: string;
  retryable?: boolean;
};

export class GmailIntegrationError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    options: { status?: number; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "GmailIntegrationError";
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable === true;
  }
}

export function errorToSendGmailResult(error: unknown, mode: GmailMode): SendGmailResult {
  if (error instanceof GmailIntegrationError) {
    return {
      success: false,
      mode,
      error_code: error.code,
      error_message: error.message,
      retryable: error.retryable,
    };
  }

  return {
    success: false,
    mode,
    error_code: "UNKNOWN_ERROR",
    error_message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}
