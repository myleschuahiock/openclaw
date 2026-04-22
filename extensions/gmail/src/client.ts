import { type FetchLike, GmailOAuthTokenProvider } from "./oauth.js";
import {
  GmailIntegrationError,
  type GmailDraftResponse,
  type GmailMessageResponse,
  type GmailRuntimeConfig,
} from "./types.js";

type GmailErrorPayload = {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{ reason?: string; message?: string }>;
  };
};

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

function jitter(baseMs: number): number {
  return Math.round(baseMs * (0.75 + Math.random() * 0.5));
}

async function readJsonError(
  response: Awaited<ReturnType<FetchLike>>,
): Promise<GmailIntegrationError> {
  const raw = await response.text();
  let payload: GmailErrorPayload | undefined;
  try {
    payload = JSON.parse(raw) as GmailErrorPayload;
  } catch {
    payload = undefined;
  }

  const status = response.status;
  const apiError = payload?.error;
  const reason = apiError?.errors?.find((entry) => entry.reason)?.reason;
  const code = apiError?.status || reason || `HTTP_${status}`;
  const message = apiError?.message || `Gmail API request failed with status ${status}`;
  return new GmailIntegrationError(code, message, {
    status,
    retryable: RETRYABLE_STATUSES.has(status),
  });
}

export class GmailApiClient {
  private readonly tokenProvider: GmailOAuthTokenProvider;
  private readonly apiBase = "https://gmail.googleapis.com/gmail/v1";

  constructor(
    private readonly config: GmailRuntimeConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.tokenProvider = new GmailOAuthTokenProvider(config, fetchImpl);
  }

  private async requestJson<T>(
    path: string,
    body: unknown,
    options: { retryAuth?: boolean } = {},
  ): Promise<T> {
    const url = `${this.apiBase}/users/${encodeURIComponent(this.config.userId)}/${path}`;
    const attempts = this.config.maxRetries + 1;
    let lastError: GmailIntegrationError | undefined;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const accessToken = await this.tokenProvider.getAccessToken();
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        return JSON.parse(await response.text()) as T;
      }

      const error = await readJsonError(response);

      if (response.status === 401 && options.retryAuth !== false && attempt === 0) {
        this.tokenProvider.clear();
        lastError = error;
        continue;
      }

      if (!error.retryable || attempt >= attempts - 1) {
        throw error;
      }

      lastError = error;
      const delay =
        retryAfterMs(response.headers.get("retry-after")) ??
        jitter(this.config.retryBaseDelayMs * 2 ** attempt);
      await sleep(delay);
    }

    throw (
      lastError ?? new GmailIntegrationError("GMAIL_REQUEST_FAILED", "Gmail API request failed")
    );
  }

  async sendRawMessage(raw: string): Promise<GmailMessageResponse> {
    return this.requestJson<GmailMessageResponse>("messages/send", { raw });
  }

  async createDraft(raw: string): Promise<GmailDraftResponse> {
    return this.requestJson<GmailDraftResponse>("drafts", { message: { raw } });
  }

  async sendDraft(draftId: string): Promise<GmailMessageResponse> {
    return this.requestJson<GmailMessageResponse>("drafts/send", { id: draftId });
  }
}

export function createGmailClient(
  config: GmailRuntimeConfig,
  fetchImpl: FetchLike = fetch,
): GmailApiClient {
  return new GmailApiClient(config, fetchImpl);
}
