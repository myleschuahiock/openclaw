import fs from "node:fs/promises";
import path from "node:path";
import { GmailIntegrationError, type PreparedAttachment } from "./types.js";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".csv": "text/csv",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".txt": "text/plain",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function detectAttachmentContentType(filePath: string): string {
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function safeFilename(filePath: string): string {
  const filename = path.basename(filePath).replace(/[\r\n"]/g, "_");
  return filename || "attachment";
}

export async function prepareAttachments(
  attachmentPaths: string[],
  options: { maxAttachmentBytes?: number } = {},
): Promise<PreparedAttachment[]> {
  const attachments: PreparedAttachment[] = [];

  for (const attachmentPath of attachmentPaths) {
    let stat;
    try {
      stat = await fs.stat(attachmentPath);
    } catch {
      throw new GmailIntegrationError(
        "ATTACHMENT_NOT_FOUND",
        `Attachment file does not exist: ${attachmentPath}`,
      );
    }

    if (!stat.isFile()) {
      throw new GmailIntegrationError(
        "ATTACHMENT_NOT_FILE",
        `Attachment path is not a file: ${attachmentPath}`,
      );
    }

    if (options.maxAttachmentBytes && stat.size > options.maxAttachmentBytes) {
      throw new GmailIntegrationError(
        "ATTACHMENT_TOO_LARGE",
        `Attachment ${attachmentPath} is ${stat.size} bytes, above the configured ${options.maxAttachmentBytes} byte limit`,
      );
    }

    attachments.push({
      path: attachmentPath,
      filename: safeFilename(attachmentPath),
      contentType: detectAttachmentContentType(attachmentPath),
      size: stat.size,
      content: await fs.readFile(attachmentPath),
    });
  }

  return attachments;
}
