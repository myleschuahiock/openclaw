import { describe, expect, it } from "vitest";
import { GmailApiClient } from "./client.js";
import type { GmailRuntimeConfig } from "./types.js";

const config: GmailRuntimeConfig = {
  sender: "miaibarra.bh@gmail.com",
  userId: "me",
  clientId: "client-id",
  clientSecret: "client-secret",
  refreshToken: "refresh-token",
  grantedScopesHint: [],
  enableDrafts: false,
  allowFromOverride: false,
  maxRawBytes: 36_700_160,
  maxRetries: 1,
  retryBaseDelayMs: 1,
  httpTimeoutMs: 100,
};

describe("gmail api client", () => {
  it("refreshes OAuth token and sends raw message", async () => {
    const urls: string[] = [];
    const fetchImpl = async (input: string | URL, init?: RequestInit) => {
      urls.push(String(input));
      if (String(input).includes("oauth2.googleapis.com")) {
        expect(String((init?.body as URLSearchParams).get("refresh_token"))).toBe("refresh-token");
        return new Response(
          JSON.stringify({ access_token: "access-token", expires_in: 3600, token_type: "Bearer" }),
          { status: 200 },
        );
      }
      expect(init?.headers).toMatchObject({ Authorization: "Bearer access-token" });
      expect(JSON.parse(String(init?.body))).toEqual({ raw: "abc" });
      return new Response(JSON.stringify({ id: "msg-1", threadId: "thread-1" }), { status: 200 });
    };

    const client = new GmailApiClient(config, fetchImpl);
    await expect(client.sendRawMessage("abc")).resolves.toEqual({
      id: "msg-1",
      threadId: "thread-1",
    });
    expect(urls.at(-1)).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
  });

  it("retries transient Gmail API errors", async () => {
    let sendAttempts = 0;
    const fetchImpl = async (input: string | URL) => {
      if (String(input).includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: "access-token", expires_in: 3600 }), {
          status: 200,
        });
      }
      sendAttempts += 1;
      if (sendAttempts === 1) {
        return new Response(JSON.stringify({ error: { status: "UNAVAILABLE" } }), {
          status: 503,
        });
      }
      return new Response(JSON.stringify({ id: "msg-2" }), { status: 200 });
    };

    const client = new GmailApiClient(config, fetchImpl);
    await expect(client.sendRawMessage("abc")).resolves.toEqual({ id: "msg-2" });
    expect(sendAttempts).toBe(2);
  });

  it("retries transient Gmail API network failures", async () => {
    let sendAttempts = 0;
    const fetchImpl = async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes("oauth2.googleapis.com")) {
        return new Response(
          JSON.stringify({
            access_token: "access-token",
            expires_in: 3600,
            scope: "https://www.googleapis.com/auth/gmail.send",
          }),
          { status: 200 },
        );
      }
      sendAttempts += 1;
      if (sendAttempts === 1) {
        const error = new TypeError("fetch failed");
        Object.assign(error, { cause: { code: "ECONNRESET" } });
        throw error;
      }
      expect(init?.headers).toMatchObject({ Authorization: "Bearer access-token" });
      return new Response(JSON.stringify({ id: "msg-3" }), { status: 200 });
    };

    const client = new GmailApiClient(config, fetchImpl);
    await expect(client.sendRawMessage("abc")).resolves.toEqual({ id: "msg-3" });
    expect(sendAttempts).toBe(2);
  });
});
