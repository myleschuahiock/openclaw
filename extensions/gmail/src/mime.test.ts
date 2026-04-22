import { describe, expect, it } from "vitest";
import { buildMimeMessage, encodeRawMessageForGmail } from "./mime.js";
import {
  GmailIntegrationError,
  type NormalizedSendGmailInput,
  type PreparedAttachment,
} from "./types.js";

const baseInput: NormalizedSendGmailInput = {
  mode: "send",
  from: "miaibarra.bh@gmail.com",
  to: ["recipient@example.com"],
  cc: [],
  bcc: [],
  subject: "Weekly Report",
  text: "Attached is the weekly report.",
  html: "<p>Attached is the weekly report.</p>",
  attachments: [],
  replyTo: "miaibarra.bh@gmail.com",
};

describe("gmail mime builder", () => {
  it("builds multipart alternative email with expected headers", () => {
    const mime = buildMimeMessage(baseInput, []);

    expect(mime).toContain("From: miaibarra.bh@gmail.com");
    expect(mime).toContain("To: recipient@example.com");
    expect(mime).toContain("Reply-To: miaibarra.bh@gmail.com");
    expect(mime).toContain("Subject: Weekly Report");
    expect(mime).toContain("Content-Type: multipart/alternative;");
    expect(mime).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(mime).toContain("Content-Type: text/html; charset=UTF-8");
  });

  it("adds attachments with detected MIME metadata", () => {
    const attachment: PreparedAttachment = {
      path: "/tmp/report.pdf",
      filename: "report.pdf",
      contentType: "application/pdf",
      size: 7,
      content: Buffer.from("PDFDATA"),
    };
    const mime = buildMimeMessage(baseInput, [attachment]);

    expect(mime).toContain("Content-Type: multipart/mixed;");
    expect(mime).toContain('Content-Type: application/pdf; name="report.pdf"');
    expect(mime).toContain('Content-Disposition: attachment; filename="report.pdf"');
    expect(mime).toContain(Buffer.from("PDFDATA").toString("base64"));
  });

  it("encodes raw MIME as Gmail base64url and enforces size", () => {
    const raw = encodeRawMessageForGmail("hello?", 100);
    expect(raw).not.toContain("+");
    expect(raw).not.toContain("/");
    expect(raw).not.toContain("=");

    expect(() => encodeRawMessageForGmail("hello world", 4)).toThrow(GmailIntegrationError);
  });
});
