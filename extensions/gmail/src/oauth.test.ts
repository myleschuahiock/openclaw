import { describe, expect, it } from "vitest";
import { refreshAccessToken } from "./oauth.js";
import { GMAIL_SEND_SCOPE, type GmailRuntimeConfig } from "./types.js";

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

describe("gmail oauth", () => {
  it("retries transient OAuth network errors", async () => {
    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new TypeError("fetch failed");
        Object.assign(error, { cause: { code: "ECONNRESET" } });
        throw error;
      }
      return new Response(
        JSON.stringify({
          access_token: "access-token",
          expires_in: 3600,
          scope: GMAIL_SEND_SCOPE,
        }),
        { status: 200 },
      );
    };

    const token = await refreshAccessToken(config, fetchImpl);
    expect(token.accessToken).toBe("access-token");
    expect(token.grantedScopes).toEqual([GMAIL_SEND_SCOPE]);
    expect(token.scopeSource).toBe("token_response");
    expect(attempts).toBe(2);
  });

  it("falls back to configured granted scopes when refresh response omits scope", async () => {
    const token = await refreshAccessToken(
      { ...config, grantedScopesHint: [GMAIL_SEND_SCOPE] },
      async () =>
        new Response(
          JSON.stringify({
            access_token: "access-token",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
    );

    expect(token.grantedScopes).toEqual([GMAIL_SEND_SCOPE]);
    expect(token.scopeSource).toBe("configured_hint");
    expect(token.scope).toBe(GMAIL_SEND_SCOPE);
  });
});
