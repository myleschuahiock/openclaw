import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectAttachmentContentType, prepareAttachments } from "./attachments.js";
import { GmailIntegrationError } from "./types.js";

describe("gmail attachments", () => {
  it("detects common attachment content types", () => {
    expect(detectAttachmentContentType("report.pdf")).toBe("application/pdf");
    expect(detectAttachmentContentType("sheet.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(detectAttachmentContentType("data.csv")).toBe("text/csv");
    expect(detectAttachmentContentType("image.jpg")).toBe("image/jpeg");
    expect(detectAttachmentContentType("unknown.bin")).toBe("application/octet-stream");
  });

  it("loads files and rejects missing or oversized attachments", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gmail-test-"));
    const file = path.join(dir, "report.txt");
    await fs.writeFile(file, "hello");

    const [attachment] = await prepareAttachments([file]);
    expect(attachment.filename).toBe("report.txt");
    expect(attachment.content.toString("utf8")).toBe("hello");

    await expect(prepareAttachments([path.join(dir, "missing.pdf")])).rejects.toThrow(
      GmailIntegrationError,
    );
    await expect(prepareAttachments([file], { maxAttachmentBytes: 2 })).rejects.toThrow(
      GmailIntegrationError,
    );
  });
});
