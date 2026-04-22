import { describe, expect, it, vi } from "vitest";
import { executeBridgeRequest, parseBridgeArgs } from "./bridge-cli.js";

vi.mock("./oauth.js", () => ({
  refreshAccessToken: vi.fn(async () => ({
    accessToken: "redacted-access-token",
    expiresAt: Date.parse("2026-04-23T01:00:00.000Z"),
    scope: "https://www.googleapis.com/auth/gmail.send",
    grantedScopes: ["https://www.googleapis.com/auth/gmail.send"],
    scopeSource: "token_response",
  })),
}));

vi.mock("./send.js", () => ({
  sendGmail: vi.fn(async () => ({
    success: true,
    mode: "send",
    message_id: "msg-1",
    thread_id: "thread-1",
  })),
}));

describe("gmail bridge cli", () => {
  it("parses healthcheck mode and env file", () => {
    expect(parseBridgeArgs(["--mode", "healthcheck", "--env", "extensions/gmail/.env"])).toEqual({
      mode: "healthcheck",
      envFile: "extensions/gmail/.env",
      capability: "send",
    });
  });

  it("healthcheck does not expose access token", async () => {
    const output = await executeBridgeRequest(
      { mode: "healthcheck", envFile: "extensions/gmail/.env.example", capability: "send" },
      "",
    );

    expect(output.success).toBe(true);
    expect(JSON.stringify(output)).not.toContain("redacted-access-token");
  });

  it("send requires JSON object stdin", async () => {
    const output = await executeBridgeRequest({ mode: "send", capability: "send" }, "");

    expect(output.success).toBe(false);
    if (!output.success) {
      expect(output.error_code).toBe("INVALID_PAYLOAD");
    }
  });

  it("wraps send result in structured JSON", async () => {
    const output = await executeBridgeRequest(
      { mode: "send", envFile: "extensions/gmail/.env.example", capability: "send" },
      JSON.stringify({ to: ["a@example.com"], subject: "Hi", text: "Body" }),
    );

    expect(output).toEqual({
      success: true,
      mode: "send",
      result: {
        success: true,
        mode: "send",
        message_id: "msg-1",
        thread_id: "thread-1",
      },
    });
  });

  it("fails healthcheck when the requested capability is not granted", async () => {
    const output = await executeBridgeRequest(
      { mode: "healthcheck", envFile: "extensions/gmail/.env.example", capability: "drafts" },
      "",
    );

    expect(output.success).toBe(false);
    if (!output.success) {
      expect(output.error_code).toBe("SCOPE_INSUFFICIENT");
    }
  });
});
