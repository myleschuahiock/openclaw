import type { CronRunOutcome, CronRunStatus } from "./types.js";

const JSON_SUMMARY_PREFIX = /^\s*[{[]/;
const EXIT_CODE_RE = /\bexit code\b[^0-9-]*(-?\d+)/i;
const SIGNAL_RE = /\b(SIG[A-Z0-9]+)\b/;
const EXPLICIT_FAILURE_CODE_RE = /\bfailure code\b[^A-Za-z0-9_`-]*`?([A-Za-z0-9_:-]+)`?/gi;
const BACKTICK_FAILURE_CODE_RE = /`([A-Z][A-Z0-9_]{2,})`/g;
const FAILURE_PATTERNS = [
  /failed success criteria/i,
  /\boverall failed\b/i,
  /\brun failed overall\b/i,
  /\bnot fully successful\b/i,
  /\bnon-compliant\b/i,
  /\bdid not complete\b/i,
  /\btoken_expired\b/i,
  /\bdelivery preflight failed\b/i,
  /\brequirement was not satisfied\b/i,
  /\brequired sequence\b.*\bnot met\b/i,
];

type JsonFailureDetails = {
  code?: string;
  message?: string;
  failed: boolean;
};

export type CronWorkflowStatus = "success" | "failed" | "unknown";

export type CronWorkflowOutcome = {
  workflowStatus?: CronWorkflowStatus;
  workflowFailureCode?: string;
  workflowFailureCodes?: string[];
  workflowExitCode?: number;
  workflowTerminationSignal?: string;
  workflowDelivered?: boolean;
  workflowDeliveryStatus?: string;
};

function trimText(input?: string): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function dedupeStrings(values: Array<string | undefined>): string[] | undefined {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result.length > 0 ? result : undefined;
}

function parseJsonFailureDetails(summary?: string): JsonFailureDetails | null {
  const trimmed = trimText(summary);
  if (!trimmed || !JSON_SUMMARY_PREFIX.test(trimmed)) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const detail =
      parsed.detail && typeof parsed.detail === "object"
        ? (parsed.detail as Record<string, unknown>)
        : parsed;
    const code = trimText(typeof detail.code === "string" ? detail.code : undefined);
    const message = trimText(typeof detail.message === "string" ? detail.message : undefined);
    const statusText = trimText(typeof detail.status === "string" ? detail.status : undefined);
    return {
      code,
      message: message ?? statusText,
      failed:
        Boolean(code) ||
        Boolean(message) ||
        (Boolean(statusText) && statusText?.toLowerCase() !== "ok"),
    };
  } catch {
    return null;
  }
}

function extractFailureCodes(summary?: string): string[] | undefined {
  const text = trimText(summary);
  if (!text) {
    return undefined;
  }
  const matches: string[] = [];
  for (const match of text.matchAll(EXPLICIT_FAILURE_CODE_RE)) {
    const code = trimText(match[1]);
    if (code) {
      matches.push(code);
    }
  }
  for (const match of text.matchAll(BACKTICK_FAILURE_CODE_RE)) {
    const code = trimText(match[1]);
    if (code) {
      matches.push(code);
    }
  }
  return dedupeStrings(matches);
}

function extractExitCode(summary?: string): number | undefined {
  const text = trimText(summary);
  if (!text) {
    return undefined;
  }
  const match = text.match(EXIT_CODE_RE);
  if (!match) {
    return undefined;
  }
  const value = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(value) ? value : undefined;
}

function extractTerminationSignal(summary?: string): string | undefined {
  const text = trimText(summary);
  if (!text) {
    return undefined;
  }
  return trimText(text.match(SIGNAL_RE)?.[1]);
}

function hasWorkflowFailureMarkers(summary?: string): boolean {
  const text = trimText(summary);
  if (!text) {
    return false;
  }
  return FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

function inferWorkflowDelivery(summary?: string): {
  delivered?: boolean;
  deliveryStatus?: string;
} {
  const text = trimText(summary);
  if (!text) {
    return {};
  }
  const emailFailed =
    /\bemail\b[\s\S]{0,80}\b(not sent|failed|failed preflight|timed out|timeout|not delivered)\b/i.test(
      text,
    );
  const emailSent = /\bemail\b[\s\S]{0,80}\b(sent|delivered)\b/i.test(text) && !emailFailed;
  const telegramSent = /\btelegram\b[\s\S]{0,80}\b(sent|delivered|posted|uploaded)\b/i.test(text);
  const telegramBlocked =
    /\btelegram\b[\s\S]{0,80}\b(blocked|suppressed|not sent|not delivered)\b/i.test(text);

  if (emailFailed && telegramSent) {
    return { delivered: false, deliveryStatus: "email_failed_telegram_sent" };
  }
  if (emailFailed) {
    return { delivered: false, deliveryStatus: "email_failed" };
  }
  if (emailSent && telegramSent) {
    return { delivered: true, deliveryStatus: "email_then_telegram" };
  }
  if (telegramSent && !emailSent) {
    return { delivered: true, deliveryStatus: "telegram_only" };
  }
  if (telegramBlocked) {
    return { delivered: false, deliveryStatus: "not-delivered" };
  }
  return {};
}

function buildWorkflowFailureError(params: {
  summary?: string;
  failureCode?: string;
  exitCode?: number;
  terminationSignal?: string;
  failureMessage?: string;
}): string {
  const parts: string[] = [];
  if (params.failureCode) {
    parts.push(params.failureCode);
  }
  if (typeof params.exitCode === "number" && params.exitCode !== 0) {
    parts.push(`exit code ${params.exitCode}`);
  }
  if (params.terminationSignal) {
    parts.push(params.terminationSignal);
  }
  if (params.failureMessage) {
    parts.push(params.failureMessage);
  }
  if (parts.length > 0) {
    return `workflow failed: ${parts.join("; ")}`;
  }
  const summary = trimText(params.summary);
  return summary
    ? `workflow failed: ${summary.slice(0, 200)}`
    : "workflow reported failure in summary";
}

function resolveWorkflowStatus(params: {
  resultStatus: CronRunStatus;
  summary?: string;
  exitCode?: number;
  terminationSignal?: string;
  jsonFailure?: JsonFailureDetails | null;
}): CronWorkflowStatus {
  if (params.resultStatus === "error") {
    return "failed";
  }
  if (params.resultStatus === "skipped") {
    return "unknown";
  }
  if (
    (typeof params.exitCode === "number" && params.exitCode !== 0) ||
    Boolean(params.terminationSignal) ||
    Boolean(params.jsonFailure?.failed) ||
    hasWorkflowFailureMarkers(params.summary)
  ) {
    return "failed";
  }
  return "success";
}

export function normalizeCronRunOutcome<T extends CronRunOutcome & { delivered?: boolean }>(
  result: T,
): T & CronWorkflowOutcome {
  const summary = trimText(result.summary);
  const jsonFailure = parseJsonFailureDetails(summary);
  const exitCode = extractExitCode(summary);
  const terminationSignal = extractTerminationSignal(summary);
  const failureCodes = dedupeStrings([jsonFailure?.code, ...(extractFailureCodes(summary) ?? [])]);
  const workflowStatus = resolveWorkflowStatus({
    resultStatus: result.status,
    summary,
    exitCode,
    terminationSignal,
    jsonFailure,
  });
  const normalizedStatus: CronRunStatus =
    result.status === "ok" && workflowStatus === "failed" ? "error" : result.status;
  const inferredDelivery = inferWorkflowDelivery(summary);
  const workflowDelivered =
    inferredDelivery.delivered ??
    (typeof result.delivered === "boolean" ? result.delivered : undefined);
  const workflowDeliveryStatus =
    inferredDelivery.deliveryStatus ??
    (typeof result.delivered === "boolean"
      ? result.delivered
        ? "delivered"
        : "not-delivered"
      : undefined);
  const workflowFailureCode = failureCodes?.[0];
  const normalizedError =
    result.error ??
    (normalizedStatus === "error" && result.status !== "error"
      ? buildWorkflowFailureError({
          summary,
          failureCode: workflowFailureCode,
          exitCode,
          terminationSignal,
          failureMessage: jsonFailure?.message,
        })
      : undefined);

  return {
    ...result,
    status: normalizedStatus,
    ...(normalizedError ? { error: normalizedError } : {}),
    workflowStatus,
    ...(workflowFailureCode ? { workflowFailureCode } : {}),
    ...(failureCodes ? { workflowFailureCodes: failureCodes } : {}),
    ...(typeof exitCode === "number" ? { workflowExitCode: exitCode } : {}),
    ...(terminationSignal ? { workflowTerminationSignal: terminationSignal } : {}),
    ...(typeof workflowDelivered === "boolean" ? { workflowDelivered } : {}),
    ...(workflowDeliveryStatus ? { workflowDeliveryStatus } : {}),
  };
}
