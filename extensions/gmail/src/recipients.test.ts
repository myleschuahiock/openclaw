import { describe, expect, it } from "vitest";
import { normalizeRecipients, normalizeSendGmailInput } from "./recipients.js";
import { GmailIntegrationError, type GmailRuntimeConfig } from "./types.js";

const config: GmailRuntimeConfig = {
  sender: "miaibarra.bh@gmail.com",
  userId: "me",
  enableDrafts: true,
  allowFromOverride: false,
  maxRawBytes: 36_700_160,
  maxRetries: 0,
  retryBaseDelayMs: 500,
};

describe("gmail recipient normalization", () => {
  it("normalizes arrays, comma-separated strings, and duplicates", () => {
    expect(normalizeRecipients(["a@example.com", "A@example.com", "b@example.com"], "to")).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
    expect(normalizeRecipients("a@example.com; b@example.com", "to")).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });

  it("validates required send inputs", () => {
    const input = normalizeSendGmailInput(
      {
        to: ["recipient@example.com"],
        cc: ["recipient@example.com", "cc@example.com"],
        subject: "Subject",
        text: "Body",
        reply_to: "miaibarra.bh@gmail.com",
      },
      config,
    );

    expect(input.to).toEqual(["recipient@example.com"]);
    expect(input.cc).toEqual(["cc@example.com"]);
    expect(input.mode).toBe("send");
  });

  it("rejects header injection and disallowed from override", () => {
    expect(() =>
      normalizeSendGmailInput({ to: ["bad\n@example.com"], subject: "S", text: "B" }, config),
    ).toThrow(GmailIntegrationError);
    expect(() =>
      normalizeSendGmailInput(
        {
          to: ["recipient@example.com"],
          subject: "S",
          text: "B",
          from: "other@example.com",
        },
        config,
      ),
    ).toThrow(GmailIntegrationError);
  });
});
