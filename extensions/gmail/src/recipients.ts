import {
  GmailIntegrationError,
  type GmailRuntimeConfig,
  type NormalizedSendGmailInput,
} from "./types.js";

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

export function sanitizeHeaderValue(value: string, field: string): string {
  if (/[\r\n]/.test(value)) {
    throw new GmailIntegrationError("INVALID_HEADER", `${field} must not contain newlines`);
  }
  return value.trim();
}

function normalizeList(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => normalizeList(entry));
  }
  if (typeof value === "string") {
    return value
      .split(/[;,]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

export function normalizeEmailAddress(value: unknown, field: string): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const email = sanitizeHeaderValue(value, field);
  if (!email) {
    return undefined;
  }
  if (!EMAIL_RE.test(email)) {
    throw new GmailIntegrationError("INVALID_RECIPIENT", `${field} is not a valid email address`);
  }
  return email;
}

export function normalizeRecipients(value: unknown, field: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of normalizeList(value)) {
    const email = normalizeEmailAddress(entry, field);
    if (!email) {
      continue;
    }
    const key = email.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(email);
    }
  }
  return out;
}

function dropAlreadySeen(values: string[], seen: Set<string>): string[] {
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(value);
  }
  return out;
}

function normalizeAttachments(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new GmailIntegrationError("INVALID_ATTACHMENTS", "attachments must be an array of paths");
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new GmailIntegrationError(
        "INVALID_ATTACHMENTS",
        `attachments[${index}] must be a non-empty path`,
      );
    }
    return entry.trim();
  });
}

export function normalizeSendGmailInput(
  params: Record<string, unknown>,
  config: GmailRuntimeConfig,
): NormalizedSendGmailInput {
  const draftId =
    typeof params.draft_id === "string" && params.draft_id.trim()
      ? sanitizeHeaderValue(params.draft_id, "draft_id")
      : undefined;

  if (draftId) {
    if (!config.enableDrafts) {
      throw new GmailIntegrationError(
        "DRAFTS_DISABLED",
        "Draft sending requires enableDrafts=true and a token with gmail.compose scope",
      );
    }
    return {
      mode: "send_draft",
      from: config.sender,
      to: [],
      cc: [],
      bcc: [],
      subject: "",
      attachments: [],
      draftId,
    };
  }

  const to = normalizeRecipients(params.to, "to");
  const seen = new Set(to.map((entry) => entry.toLowerCase()));
  const cc = dropAlreadySeen(normalizeRecipients(params.cc, "cc"), seen);
  const bcc = dropAlreadySeen(normalizeRecipients(params.bcc, "bcc"), seen);

  if (to.length + cc.length + bcc.length === 0) {
    throw new GmailIntegrationError(
      "MISSING_RECIPIENT",
      "At least one to, cc, or bcc recipient is required",
    );
  }

  const subject =
    typeof params.subject === "string" ? sanitizeHeaderValue(params.subject, "subject") : "";
  if (!subject) {
    throw new GmailIntegrationError("MISSING_SUBJECT", "subject is required");
  }

  const text = typeof params.text === "string" ? params.text : undefined;
  const html = typeof params.html === "string" ? params.html : undefined;
  if (!text && !html) {
    throw new GmailIntegrationError("MISSING_BODY", "text or html body is required");
  }

  const from = normalizeEmailAddress(params.from, "from") ?? config.sender;
  if (!config.allowFromOverride && from.toLowerCase() !== config.sender.toLowerCase()) {
    throw new GmailIntegrationError(
      "FROM_NOT_ALLOWED",
      `from must be ${config.sender} unless allowFromOverride=true`,
    );
  }

  const replyTo = normalizeEmailAddress(params.reply_to, "reply_to");
  const saveAsDraft = params.save_as_draft === true;
  if (saveAsDraft && !config.enableDrafts) {
    throw new GmailIntegrationError(
      "DRAFTS_DISABLED",
      "Draft creation requires enableDrafts=true and a token with gmail.compose scope",
    );
  }

  return {
    mode: saveAsDraft ? "create_draft" : "send",
    from,
    to,
    cc,
    bcc,
    subject,
    text,
    html,
    attachments: normalizeAttachments(params.attachments),
    replyTo,
  };
}
