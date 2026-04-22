import crypto from "node:crypto";
import {
  type FetchLike,
  RETRYABLE_STATUSES,
  coerceRetryableFetchError,
  fetchWithTimeout,
  jitter,
  retryAfterMs,
  sleep,
} from "./http.js";
import { resolveGrantedScopes, type GmailScopeSource } from "./scopes.js";
import { GmailIntegrationError, type GmailRuntimeConfig } from "./types.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

export type OAuthTokenResult = {
  accessToken: string;
  expiresAt: number;
  scope?: string;
  grantedScopes: string[];
  scopeSource: GmailScopeSource;
};

function requireOAuthConfig(config: GmailRuntimeConfig): {
  clientId: string;
  refreshToken: string;
  clientSecret?: string;
} {
  if (!config.clientId) {
    throw new GmailIntegrationError("MISSING_OAUTH_CONFIG", "GMAIL_OAUTH_CLIENT_ID is required");
  }
  if (!config.refreshToken) {
    throw new GmailIntegrationError(
      "MISSING_OAUTH_CONFIG",
      "GMAIL_OAUTH_REFRESH_TOKEN is required",
    );
  }
  return {
    clientId: config.clientId,
    refreshToken: config.refreshToken,
    clientSecret: config.clientSecret,
  };
}

async function parseTokenResponse(
  response: Awaited<ReturnType<FetchLike>>,
): Promise<TokenResponse> {
  const raw = await response.text();
  try {
    return JSON.parse(raw) as TokenResponse;
  } catch {
    throw new GmailIntegrationError(
      "OAUTH_BAD_RESPONSE",
      `Google OAuth token endpoint returned non-JSON status ${response.status}`,
      { status: response.status, retryable: RETRYABLE_STATUSES.has(response.status) },
    );
  }
}

export async function refreshAccessToken(
  config: GmailRuntimeConfig,
  fetchImpl: FetchLike = fetch,
): Promise<OAuthTokenResult> {
  const oauth = requireOAuthConfig(config);
  const body = new URLSearchParams({
    client_id: oauth.clientId,
    refresh_token: oauth.refreshToken,
    grant_type: "refresh_token",
  });
  if (oauth.clientSecret) {
    body.set("client_secret", oauth.clientSecret);
  }

  const attempts = config.maxRetries + 1;
  let lastError: GmailIntegrationError | undefined;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetchWithTimeout(
        fetchImpl,
        GOOGLE_TOKEN_URL,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        },
        config.httpTimeoutMs,
      );
    } catch (error) {
      const classified =
        coerceRetryableFetchError(error, {
          timeoutCode: "OAUTH_TIMEOUT",
          timeoutMessage: `Google OAuth token request timed out after ${config.httpTimeoutMs} ms`,
          networkCode: "OAUTH_REQUEST_FAILED",
          networkMessagePrefix: "Google OAuth token request failed",
        }) ??
        new GmailIntegrationError(
          "OAUTH_REQUEST_FAILED",
          error instanceof Error ? error.message : String(error),
        );
      if (!classified.retryable || attempt >= attempts - 1) {
        throw classified;
      }
      lastError = classified;
      await sleep(jitter(config.retryBaseDelayMs * 2 ** attempt));
      continue;
    }

    const token = await parseTokenResponse(response);
    if (!response.ok || !token.access_token) {
      const refreshError = new GmailIntegrationError(
        "OAUTH_REFRESH_FAILED",
        token.error_description ||
          token.error ||
          `OAuth refresh failed with status ${response.status}`,
        { status: response.status, retryable: RETRYABLE_STATUSES.has(response.status) },
      );
      if (!refreshError.retryable || attempt >= attempts - 1) {
        throw refreshError;
      }
      lastError = refreshError;
      await sleep(
        retryAfterMs(response.headers.get("retry-after")) ??
          jitter(config.retryBaseDelayMs * 2 ** attempt),
      );
      continue;
    }

    const scopeDetails = resolveGrantedScopes(token.scope, config.grantedScopesHint);
    return {
      accessToken: token.access_token,
      expiresAt: Date.now() + Math.max(60, token.expires_in ?? 3600) * 1000,
      scope: scopeDetails.scope,
      grantedScopes: scopeDetails.grantedScopes,
      scopeSource: scopeDetails.scopeSource,
    };
  }

  throw (
    lastError ??
    new GmailIntegrationError("OAUTH_REFRESH_FAILED", "OAuth refresh failed before completion")
  );
}

export class GmailOAuthTokenProvider {
  private cached?: OAuthTokenResult;

  constructor(
    private readonly config: GmailRuntimeConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  clear(): void {
    this.cached = undefined;
  }

  async getToken(): Promise<OAuthTokenResult> {
    if (this.cached && this.cached.expiresAt - Date.now() > 60_000) {
      return this.cached;
    }
    this.cached = await refreshAccessToken(this.config, this.fetchImpl);
    return this.cached;
  }

  async getAccessToken(): Promise<string> {
    const token = await this.getToken();
    return token.accessToken;
  }
}

export function generateCodeVerifier(): string {
  return crypto.randomBytes(48).toString("base64url");
}

export function codeChallengeS256(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export function buildAuthorizationUrl(params: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  loginHint?: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", params.scopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (params.loginHint) {
    url.searchParams.set("login_hint", params.loginHint);
  }
  return url.toString();
}

export async function exchangeAuthorizationCode(
  params: {
    clientId: string;
    clientSecret?: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  },
  fetchImpl: FetchLike = fetch,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: params.clientId,
    code: params.code,
    code_verifier: params.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: params.redirectUri,
  });
  if (params.clientSecret) {
    body.set("client_secret", params.clientSecret);
  }

  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const token = await parseTokenResponse(response);
  if (!response.ok) {
    throw new GmailIntegrationError(
      "OAUTH_CODE_EXCHANGE_FAILED",
      token.error_description ||
        token.error ||
        `OAuth code exchange failed with status ${response.status}`,
      { status: response.status },
    );
  }
  return token;
}
