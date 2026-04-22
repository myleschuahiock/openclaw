import crypto from "node:crypto";
import {
  GmailIntegrationError,
  type NormalizedSendGmailInput,
  type PreparedAttachment,
} from "./types.js";

const CRLF = "\r\n";

function boundary(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

function base64Lines(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/.{1,76}/g, "$&\r\n")
    .trimEnd();
}

function needsEncodedWord(value: string): boolean {
  return /[^\x20-\x7e]/.test(value);
}

function encodeHeaderValue(value: string): string {
  if (!needsEncodedWord(value)) {
    return value;
  }
  const encoded = Buffer.from(value, "utf8").toString("base64");
  return encoded
    .match(/.{1,52}/g)!
    .map((chunk) => `=?UTF-8?B?${chunk}?=`)
    .join(`${CRLF} `);
}

function encodeFilenameParam(filename: string): string {
  if (/^[A-Za-z0-9._ -]+$/.test(filename)) {
    return `filename="${filename.replace(/"/g, "_")}"`;
  }
  return `filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function header(name: string, value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return [`${name}: ${encodeHeaderValue(value)}`];
}

function addressHeader(name: string, values: string[]): string[] {
  if (values.length === 0) {
    return [];
  }
  return [`${name}: ${values.join(", ")}`];
}

function textPart(subtype: "plain" | "html", content: string): string {
  return [
    `Content-Type: text/${subtype}; charset=UTF-8`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(content),
  ].join(CRLF);
}

function alternativePart(input: NormalizedSendGmailInput, altBoundary: string): string {
  const parts: string[] = [];
  if (input.text) {
    parts.push(`--${altBoundary}`, textPart("plain", input.text));
  }
  if (input.html) {
    parts.push(`--${altBoundary}`, textPart("html", input.html));
  }
  parts.push(`--${altBoundary}--`);
  return [
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    "",
    parts.join(CRLF),
  ].join(CRLF);
}

function bodyPart(input: NormalizedSendGmailInput): string {
  if (input.text && input.html) {
    return alternativePart(input, boundary("openclaw_gmail_alt"));
  }
  if (input.html) {
    return textPart("html", input.html);
  }
  return textPart("plain", input.text ?? "");
}

function attachmentPart(attachment: PreparedAttachment): string {
  const filenameParam = encodeFilenameParam(attachment.filename);
  const nameParam = filenameParam.replace(/^filename/, "name");
  return [
    `Content-Type: ${attachment.contentType}; ${nameParam}`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; ${filenameParam}`,
    "",
    base64Lines(attachment.content),
  ].join(CRLF);
}

function messageId(from: string): string {
  const domain = from.split("@")[1] || "gmail.local";
  return `<${crypto.randomUUID()}@openclaw.${domain}>`;
}

export function buildMimeMessage(
  input: NormalizedSendGmailInput,
  attachments: PreparedAttachment[],
): string {
  const headers = [
    ...header("Date", new Date().toUTCString()),
    ...header("Message-ID", messageId(input.from)),
    ...header("MIME-Version", "1.0"),
    ...header("From", input.from),
    ...addressHeader("To", input.to),
    ...addressHeader("Cc", input.cc),
    ...addressHeader("Bcc", input.bcc),
    ...header("Reply-To", input.replyTo),
    ...header("Subject", input.subject),
  ];

  if (attachments.length === 0) {
    return [headers.join(CRLF), bodyPart(input)].join(`${CRLF}${CRLF}`);
  }

  const mixedBoundary = boundary("openclaw_gmail_mixed");
  const parts = [`--${mixedBoundary}`, bodyPart(input)];
  for (const attachment of attachments) {
    parts.push(`--${mixedBoundary}`, attachmentPart(attachment));
  }
  parts.push(`--${mixedBoundary}--`);

  return [
    [...headers, `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`].join(CRLF),
    parts.join(CRLF),
  ].join(`${CRLF}${CRLF}`);
}

export function encodeRawMessageForGmail(mime: string, maxRawBytes: number): string {
  const raw = Buffer.from(mime, "utf8").toString("base64url");
  if (Buffer.byteLength(raw, "utf8") > maxRawBytes) {
    throw new GmailIntegrationError(
      "MESSAGE_TOO_LARGE",
      `Encoded MIME message is ${Buffer.byteLength(raw, "utf8")} bytes, above the configured ${maxRawBytes} byte Gmail API limit`,
    );
  }
  return raw;
}
