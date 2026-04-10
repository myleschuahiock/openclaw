import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CronRunOutcome } from "./types.js";
import { normalizeCronRunOutcome } from "./workflow-outcome.js";

function normalizeOutcome(result: CronRunOutcome & { delivered?: boolean }) {
  return normalizeCronRunOutcome(result);
}

describe("normalizeCronRunOutcome", () => {
  it("promotes failed workflow summaries to cron errors and extracts metadata", () => {
    const result = normalizeOutcome({
      status: "ok" as const,
      delivered: false,
      summary: [
        "Run completed, but failed success criteria due to email preflight failure.",
        "",
        "Final status: exit code 1",
        "Failure code: `MAIL_APP_TIMEOUT` (`OSASCRIPT_TIMEOUT` after 90 seconds)",
        "Email: not sent",
        "Telegram: sent",
      ].join("\n"),
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("MAIL_APP_TIMEOUT");
    expect(result.workflowStatus).toBe("failed");
    expect(result.workflowFailureCode).toBe("MAIL_APP_TIMEOUT");
    expect(result.workflowFailureCodes).toContain("OSASCRIPT_TIMEOUT");
    expect(result.workflowExitCode).toBe(1);
    expect(result.workflowDelivered).toBe(false);
    expect(result.workflowDeliveryStatus).toBe("email_failed_telegram_sent");
  });

  it("treats JSON auth failures as workflow errors", () => {
    const result = normalizeOutcome({
      status: "ok" as const,
      summary:
        '{"detail":{"code":"token_expired","message":"Provided authentication token is expired. Please try signing in again."}}',
    });

    expect(result.status).toBe("error");
    expect(result.workflowStatus).toBe("failed");
    expect(result.workflowFailureCode).toBe("token_expired");
    expect(result.error).toContain("token_expired");
  });

  it("captures termination signals from interruption summaries", () => {
    const result = normalizeOutcome({
      status: "ok" as const,
      summary: [
        "Run failed before completion.",
        "",
        "- The process ended with SIGKILL while still in codex pass.",
        "- The workflow did not complete its delivery phase.",
      ].join("\n"),
    });

    expect(result.status).toBe("error");
    expect(result.workflowStatus).toBe("failed");
    expect(result.workflowTerminationSignal).toBe("SIGKILL");
  });

  it("does not fail a run solely because a failure code is mentioned in normal text", () => {
    const result = normalizeOutcome({
      status: "ok" as const,
      summary:
        "Reference note: `MAIL_APP_TIMEOUT` is the code to watch for in tomorrow's validation.",
    });

    expect(result.status).toBe("ok");
    expect(result.workflowStatus).toBe("success");
    expect(result.workflowFailureCode).toBe("MAIL_APP_TIMEOUT");
  });

  it("uses workflow delivery truth when the summary shows delivery succeeded", () => {
    const result = normalizeOutcome({
      status: "ok" as const,
      delivered: false,
      summary: ["Email: sent", "Telegram: sent"].join("\n"),
    });

    expect(result.status).toBe("ok");
    expect(result.workflowStatus).toBe("success");
    expect(result.workflowDelivered).toBe(true);
    expect(result.workflowDeliveryStatus).toBe("email_then_telegram");
  });

  it("treats 'Telegram posted after email' as delivered workflow success", () => {
    const result = normalizeOutcome({
      status: "ok" as const,
      delivered: false,
      summary: [
        "Done, myles — the run completed successfully (`exit code 0`).",
        "",
        "✅ Delivery order satisfied in the same run:",
        "1) **Email sent first** (Apple Mail transport, verified in Sent mailbox)",
        "2) **Telegram posted after email** to configured group/thread, including the **same attachments**",
      ].join("\n"),
    });

    expect(result.status).toBe("ok");
    expect(result.workflowStatus).toBe("success");
    expect(result.workflowDelivered).toBe(true);
    expect(result.workflowDeliveryStatus).toBe("email_then_telegram");
  });

  it("uses run-manifest truth when the summary says email was attempted but not sent", () => {
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cron-workflow-outcome-"));
    const runFolder = path.join(runRoot, "daily-screener 2026-04-10");
    fs.mkdirSync(runFolder, { recursive: true });
    fs.writeFileSync(
      path.join(runFolder, "run-manifest.json"),
      JSON.stringify(
        {
          terminal_status: "degraded",
          success: true,
          failure_code: null,
          failure_codes: [],
          delivery: {
            preflight: {
              blocking_codes: ["MAIL_ACCOUNT_PROBE_TIMEOUT", "AUTH_REQUIRED"],
              degraded_codes: ["MAIL_ACCOUNT_PROBE_TIMEOUT", "AUTH_REQUIRED"],
            },
            email: {
              sent: false,
              failure_codes: ["AUTH_REQUIRED", "MAIL_ACCOUNT_PROBE_TIMEOUT"],
            },
            telegram: {
              sent: true,
            },
            delivery_state: "telegram_only_degraded",
          },
          delivery_verification: {
            status: "degraded",
            ok: true,
            degraded_codes: ["MAIL_ACCOUNT_PROBE_TIMEOUT", "AUTH_REQUIRED"],
            checks: {
              email_sent: false,
              telegram_sent: true,
              email_failure_fallback: true,
              telegram_primary_hash_present: true,
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    try {
      const result = normalizeOutcome({
        status: "ok" as const,
        delivered: false,
        summary: [
          "Done — the run completed successfully (`exit code 0`).",
          "",
          `Run folder: ${runFolder}`,
          "Email first attempted: yes",
          "Email with attachments sent: no",
          "Telegram fallback delivery only",
        ].join("\n"),
      });

      expect(result.status).toBe("ok");
      expect(result.workflowStatus).toBe("success");
      expect(result.workflowFailureCode).toBe("MAIL_ACCOUNT_PROBE_TIMEOUT");
      expect(result.workflowFailureCodes).toEqual(["MAIL_ACCOUNT_PROBE_TIMEOUT", "AUTH_REQUIRED"]);
      expect(result.workflowDelivered).toBe(false);
      expect(result.workflowDeliveryStatus).toBe("telegram_only_degraded");
    } finally {
      fs.rmSync(runRoot, { recursive: true, force: true });
    }
  });

  it("keeps the older summary fallback conservative when email was attempted but not sent", () => {
    const result = normalizeOutcome({
      status: "ok" as const,
      delivered: false,
      summary: [
        "Done — the run completed successfully (`exit code 0`).",
        "",
        "Email first attempted: yes",
        "Email with attachments sent: no",
        "Telegram: sent",
      ].join("\n"),
    });

    expect(result.status).toBe("ok");
    expect(result.workflowStatus).toBe("success");
    expect(result.workflowDelivered).toBe(false);
    expect(result.workflowDeliveryStatus).toBe("email_failed_telegram_sent");
  });

  it("leaves successful summaries untouched", () => {
    const result = normalizeOutcome({
      status: "ok" as const,
      summary: "Run completed successfully.",
    });

    expect(result.status).toBe("ok");
    expect(result.workflowStatus).toBe("success");
    expect(result.error).toBeUndefined();
  });
});
