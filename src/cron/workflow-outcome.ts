import fs from "node:fs";
import path from "node:path";
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

type ManifestRecord = Record<string, unknown>;

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

function isRecord(value: unknown): value is ManifestRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getNestedValue(value: unknown, keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function getNestedString(value: unknown, keys: string[]): string | undefined {
  const nested = getNestedValue(value, keys);
  return typeof nested === "string" ? trimText(nested) : undefined;
}

function getNestedBoolean(value: unknown, keys: string[]): boolean | undefined {
  const nested = getNestedValue(value, keys);
  return typeof nested === "boolean" ? nested : undefined;
}

function getNestedStringArray(value: unknown, keys: string[]): string[] | undefined {
  const nested = getNestedValue(value, keys);
  if (!Array.isArray(nested)) {
    return undefined;
  }
  const values = nested
    .map((item) => (typeof item === "string" ? trimText(item) : undefined))
    .filter((item): item is string => Boolean(item));
  return values.length > 0 ? values : undefined;
}

function cleanPathCandidate(value?: string): string | undefined {
  const trimmed = trimText(value);
  if (!trimmed) {
    return undefined;
  }
  const unwrapped = trimmed
    .replace(/^`|`$/g, "")
    .replace(/^["']|["']$/g, "")
    .trim();
  const cleaned = unwrapped.replace(/[),.;]+$/g, "").trim();
  return cleaned.startsWith("/") ? cleaned : undefined;
}

function extractRunFolderPathFromSummary(summary?: string): string | undefined {
  const text = trimText(summary);
  if (!text) {
    return undefined;
  }
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }
    if (/run-manifest\.json/i.test(line)) {
      const candidate =
        cleanPathCandidate(line.match(/`([^`]+run-manifest\.json[^`]*)`/)?.[1]) ??
        cleanPathCandidate(line.match(/(\/[^`"'`]*run-manifest\.json[^`"'`]*)/i)?.[1]) ??
        cleanPathCandidate(line);
      if (candidate) {
        return candidate;
      }
    }
    if (/^run folder:/i.test(line)) {
      const inline = cleanPathCandidate(line.slice(line.indexOf(":") + 1));
      if (inline) {
        return inline;
      }
      for (const nextLine of lines.slice(index + 1, index + 4)) {
        const candidate = cleanPathCandidate(nextLine);
        if (candidate) {
          return candidate;
        }
      }
    }
  }
  return undefined;
}

function resolveManifestPathFromSummary(summary?: string): string | undefined {
  const runFolderPath = extractRunFolderPathFromSummary(summary);
  if (!runFolderPath) {
    return undefined;
  }
  return runFolderPath.endsWith("run-manifest.json")
    ? path.resolve(runFolderPath)
    : path.resolve(runFolderPath, "run-manifest.json");
}

function readWorkflowManifest(summary?: string): ManifestRecord | undefined {
  const manifestPath = resolveManifestPathFromSummary(summary);
  if (!manifestPath) {
    return undefined;
  }
  try {
    const raw = fs.readFileSync(manifestPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeManifestWorkflowStatus(manifest: ManifestRecord): CronWorkflowStatus | undefined {
  const terminalStatus = getNestedString(manifest, ["terminal_status"])?.toLowerCase();
  if (
    terminalStatus === "failed" ||
    terminalStatus === "error" ||
    terminalStatus === "interrupted"
  ) {
    return "failed";
  }
  if (terminalStatus === "success" || terminalStatus === "degraded") {
    return "success";
  }
  const success = getNestedValue(manifest, ["success"]);
  if (typeof success === "boolean") {
    return success ? "success" : "failed";
  }
  return undefined;
}

function normalizeManifestDeliveryOutcome(manifest: ManifestRecord): {
  delivered?: boolean;
  deliveryStatus?: string;
} {
  const deliveryState = getNestedString(manifest, ["delivery", "delivery_state"]);
  if (deliveryState) {
    const normalized = deliveryState.toLowerCase();
    if (normalized === "email_then_telegram" || normalized === "telegram_only") {
      return { delivered: true, deliveryStatus: normalized };
    }
    if (
      normalized === "email_failed_telegram_sent" ||
      normalized === "email_failed" ||
      normalized === "telegram_only_degraded" ||
      normalized === "not-delivered"
    ) {
      return { delivered: false, deliveryStatus: normalized };
    }
    return { deliveryStatus: normalized };
  }

  const telegramSent = getNestedBoolean(manifest, [
    "delivery_verification",
    "checks",
    "telegram_sent",
  ]);
  const emailSent = getNestedBoolean(manifest, ["delivery_verification", "checks", "email_sent"]);
  if (typeof telegramSent === "boolean" || typeof emailSent === "boolean") {
    if (emailSent && telegramSent) {
      return { delivered: true, deliveryStatus: "email_then_telegram" };
    }
    if (telegramSent && !emailSent) {
      const verificationStatus = getNestedString(manifest, [
        "delivery_verification",
        "status",
      ])?.toLowerCase();
      return {
        delivered: false,
        deliveryStatus:
          verificationStatus === "degraded"
            ? "telegram_only_degraded"
            : "email_failed_telegram_sent",
      };
    }
    if (telegramSent) {
      return { delivered: true, deliveryStatus: "telegram_only" };
    }
    if (emailSent) {
      return { delivered: true, deliveryStatus: "email_only" };
    }
    return { delivered: false, deliveryStatus: "not-delivered" };
  }

  return {};
}

function extractWorkflowOutcomeFromManifest(
  manifest: ManifestRecord,
): CronWorkflowOutcome | undefined {
  const workflowStatus = normalizeManifestWorkflowStatus(manifest);
  const deliveryOutcome = normalizeManifestDeliveryOutcome(manifest);
  const failureCodes = dedupeStrings([
    ...(getNestedStringArray(manifest, ["delivery", "preflight", "blocking_codes"]) ?? []),
    ...(getNestedStringArray(manifest, ["delivery", "preflight", "degraded_codes"]) ?? []),
    ...(getNestedStringArray(manifest, ["failure_codes"]) ?? []),
    ...(getNestedStringArray(manifest, ["delivery", "email", "failure_codes"]) ?? []),
    ...(getNestedStringArray(manifest, ["delivery_verification", "degraded_codes"]) ?? []),
    getNestedString(manifest, ["failure_code"]),
  ]);

  const workflowFailureCode = failureCodes?.[0];
  const workflowExitCode = getNestedValue(manifest, ["workflow_exit_code"]);
  const workflowTerminationSignal = getNestedString(manifest, ["workflow_termination_signal"]);

  return {
    ...(workflowStatus ? { workflowStatus } : {}),
    ...(workflowFailureCode ? { workflowFailureCode } : {}),
    ...(failureCodes ? { workflowFailureCodes: failureCodes } : {}),
    ...(typeof workflowExitCode === "number" ? { workflowExitCode } : {}),
    ...(workflowTerminationSignal ? { workflowTerminationSignal } : {}),
    ...(typeof deliveryOutcome.delivered === "boolean"
      ? { workflowDelivered: deliveryOutcome.delivered }
      : {}),
    ...(deliveryOutcome.deliveryStatus
      ? { workflowDeliveryStatus: deliveryOutcome.deliveryStatus }
      : {}),
  };
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
    /\bemail\b[\s\S]{0,80}\b(not sent|failed|failed preflight|timed out|timeout|not delivered|sent\s*:\s*no|sent\s+no)\b/i.test(
      text,
    );
  const emailSent =
    /\bemail\b[\s\S]{0,80}\b(sent|delivered|verified in sent mailbox|sent via email)\b/i.test(
      text,
    ) && !emailFailed;
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
  const manifest = readWorkflowManifest(summary);
  const structuredWorkflowOutcome = manifest
    ? extractWorkflowOutcomeFromManifest(manifest)
    : undefined;
  const jsonFailure = parseJsonFailureDetails(summary);
  const exitCode = extractExitCode(summary);
  const terminationSignal = extractTerminationSignal(summary);
  const structuredFailureCodes = structuredWorkflowOutcome
    ? dedupeStrings([
        structuredWorkflowOutcome.workflowFailureCode,
        ...(structuredWorkflowOutcome.workflowFailureCodes ?? []),
      ])
    : undefined;
  const summaryFailureCodes = dedupeStrings([
    jsonFailure?.code,
    ...(extractFailureCodes(summary) ?? []),
  ]);
  const failureCodes = structuredFailureCodes ?? summaryFailureCodes;
  const workflowStatus =
    structuredWorkflowOutcome?.workflowStatus ??
    resolveWorkflowStatus({
      resultStatus: result.status,
      summary,
      exitCode,
      terminationSignal,
      jsonFailure,
    });
  const normalizedStatus: CronRunStatus = structuredWorkflowOutcome?.workflowStatus
    ? structuredWorkflowOutcome.workflowStatus === "failed"
      ? "error"
      : result.status === "skipped"
        ? "skipped"
        : "ok"
    : result.status === "ok" && workflowStatus === "failed"
      ? "error"
      : result.status;
  const inferredDelivery = inferWorkflowDelivery(summary);
  const workflowDelivered =
    structuredWorkflowOutcome?.workflowDelivered ??
    inferredDelivery.delivered ??
    (typeof result.delivered === "boolean" ? result.delivered : undefined);
  const workflowDeliveryStatus =
    structuredWorkflowOutcome?.workflowDeliveryStatus ??
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
