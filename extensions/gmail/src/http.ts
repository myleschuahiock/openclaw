import { GmailIntegrationError } from "./types.js";

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "headers" | "text">>;

export const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function retryAfterMs(value: string | null): number | undefined {
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

export function jitter(baseMs: number): number {
  return Math.round(baseMs * (0.75 + Math.random() * 0.5));
}

function abortError(): Error {
  try {
    return new DOMException("The operation was aborted.", "AbortError");
  } catch {
    const error = new Error("The operation was aborted.");
    error.name = "AbortError";
    return error;
  }
}

export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  input: string | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Awaited<ReturnType<FetchLike>>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(abortError()), timeoutMs);
  const externalSignal = init.signal;

  const cleanupExternal =
    externalSignal && !externalSignal.aborted
      ? (() => {
          const onAbort = () => controller.abort(externalSignal.reason);
          externalSignal.addEventListener("abort", onAbort, { once: true });
          return () => externalSignal.removeEventListener("abort", onAbort);
        })()
      : undefined;

  if (externalSignal?.aborted) {
    clearTimeout(timeout);
    cleanupExternal?.();
    throw externalSignal.reason ?? abortError();
  }

  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    cleanupExternal?.();
  }
}

export function coerceRetryableFetchError(
  error: unknown,
  options: {
    timeoutCode: string;
    timeoutMessage: string;
    networkCode: string;
    networkMessagePrefix: string;
  },
): GmailIntegrationError | undefined {
  if (error instanceof GmailIntegrationError) {
    return error;
  }

  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || name === "TimeoutError") {
    return new GmailIntegrationError(options.timeoutCode, options.timeoutMessage, {
      retryable: true,
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  const code =
    (error as { code?: string; cause?: { code?: string } } | null | undefined)?.code ??
    (error as { cause?: { code?: string } } | null | undefined)?.cause?.code;

  if (
    (typeof code === "string" && RETRYABLE_NETWORK_CODES.has(code)) ||
    /fetch failed|socket|network|timed out|timeout|connect/i.test(message)
  ) {
    const suffix = message ? `: ${message}` : "";
    return new GmailIntegrationError(
      options.networkCode,
      `${options.networkMessagePrefix}${suffix}`,
      { retryable: true },
    );
  }

  return undefined;
}
