import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createFinishedBarrier,
  createStartedCronServiceWithFinishedBarrier,
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();
installCronTestHooks({ logger: noopLogger });

type CronAddInput = Parameters<CronService["add"]>[0];

function buildIsolatedAgentTurnJob(name: string): CronAddInput {
  return {
    name,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "test" },
    delivery: { mode: "none" },
  };
}

function buildMainSessionSystemEventJob(name: string): CronAddInput {
  return {
    name,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "tick" },
  };
}

function createIsolatedCronWithFinishedBarrier(params: {
  storePath: string;
  delivered?: boolean;
  onFinished?: (evt: { jobId: string; delivered?: boolean; deliveryStatus?: string }) => void;
}) {
  const finished = createFinishedBarrier();
  const cron = new CronService({
    storePath: params.storePath,
    cronEnabled: true,
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
      ...(params.delivered === undefined ? {} : { delivered: params.delivered }),
    })),
    onEvent: (evt) => {
      if (evt.action === "finished") {
        params.onFinished?.({
          jobId: evt.jobId,
          delivered: evt.delivered,
          deliveryStatus: evt.deliveryStatus,
        });
      }
      finished.onEvent(evt);
    },
  });
  return { cron, finished };
}

async function runSingleJobAndReadState(params: {
  cron: CronService;
  finished: ReturnType<typeof createFinishedBarrier>;
  job: CronAddInput;
}) {
  const job = await params.cron.add(params.job);
  vi.setSystemTime(new Date(job.state.nextRunAtMs! + 5));
  await vi.runOnlyPendingTimersAsync();
  await params.finished.waitForOk(job.id);

  const jobs = await params.cron.list({ includeDisabled: true });
  return { job, updated: jobs.find((entry) => entry.id === job.id) };
}

function expectSuccessfulCronRun(
  updated:
    | {
        state: {
          lastStatus?: string;
          lastRunStatus?: string;
          [key: string]: unknown;
        };
      }
    | undefined,
) {
  expect(updated?.state.lastStatus).toBe("ok");
  expect(updated?.state.lastRunStatus).toBe("ok");
}

function expectDeliveryNotRequested(
  updated:
    | {
        state: {
          lastDelivered?: boolean;
          lastDeliveryStatus?: string;
          lastDeliveryError?: string;
        };
      }
    | undefined,
) {
  expectSuccessfulCronRun(updated);
  expect(updated?.state.lastDelivered).toBeUndefined();
  expect(updated?.state.lastDeliveryStatus).toBe("not-requested");
  expect(updated?.state.lastDeliveryError).toBeUndefined();
}

async function runIsolatedJobAndReadState(params: {
  job: CronAddInput;
  delivered?: boolean;
  onFinished?: (evt: { jobId: string; delivered?: boolean; deliveryStatus?: string }) => void;
}) {
  const store = await makeStorePath();
  const { cron, finished } = createIsolatedCronWithFinishedBarrier({
    storePath: store.storePath,
    ...(params.delivered !== undefined ? { delivered: params.delivered } : {}),
    ...(params.onFinished ? { onFinished: params.onFinished } : {}),
  });

  await cron.start();
  try {
    const { updated } = await runSingleJobAndReadState({
      cron,
      finished,
      job: params.job,
    });
    return updated;
  } finally {
    cron.stop();
  }
}

describe("CronService persists delivered status", () => {
  it("persists lastDelivered=true when isolated job reports delivered", async () => {
    const updated = await runIsolatedJobAndReadState({
      job: buildIsolatedAgentTurnJob("delivered-true"),
      delivered: true,
    });
    expectSuccessfulCronRun(updated);
    expect(updated?.state.lastDelivered).toBe(true);
    expect(updated?.state.lastDeliveryStatus).toBe("delivered");
    expect(updated?.state.lastDeliveryError).toBeUndefined();
  });

  it("persists lastDelivered=false when isolated job explicitly reports not delivered", async () => {
    const updated = await runIsolatedJobAndReadState({
      job: buildIsolatedAgentTurnJob("delivered-false"),
      delivered: false,
    });
    expectSuccessfulCronRun(updated);
    expect(updated?.state.lastDelivered).toBe(false);
    expect(updated?.state.lastDeliveryStatus).toBe("not-delivered");
    expect(updated?.state.lastDeliveryError).toBeUndefined();
  });

  it("persists not-requested delivery state when delivery is not configured", async () => {
    const updated = await runIsolatedJobAndReadState({
      job: buildIsolatedAgentTurnJob("no-delivery"),
    });
    expectDeliveryNotRequested(updated);
  });

  it("persists unknown delivery state when delivery is requested but the runner omits delivered", async () => {
    const updated = await runIsolatedJobAndReadState({
      job: {
        ...buildIsolatedAgentTurnJob("delivery-unknown"),
        delivery: { mode: "announce", channel: "telegram", to: "123" },
      },
    });
    expectSuccessfulCronRun(updated);
    expect(updated?.state.lastDelivered).toBeUndefined();
    expect(updated?.state.lastDeliveryStatus).toBe("unknown");
    expect(updated?.state.lastDeliveryError).toBeUndefined();
  });

  it("does not set lastDelivered for main session jobs", async () => {
    const store = await makeStorePath();
    const { cron, enqueueSystemEvent, finished } = createStartedCronServiceWithFinishedBarrier({
      storePath: store.storePath,
      logger: noopLogger,
    });

    await cron.start();
    const { updated } = await runSingleJobAndReadState({
      cron,
      finished,
      job: buildMainSessionSystemEventJob("main-session"),
    });

    expectDeliveryNotRequested(updated);
    expect(enqueueSystemEvent).toHaveBeenCalled();

    cron.stop();
  });

  it("emits delivered in the finished event", async () => {
    let capturedEvent: { jobId: string; delivered?: boolean; deliveryStatus?: string } | undefined;
    await runIsolatedJobAndReadState({
      job: buildIsolatedAgentTurnJob("event-test"),
      delivered: true,
      onFinished: (evt) => {
        capturedEvent = evt;
      },
    });

    expect(capturedEvent).toBeDefined();
    expect(capturedEvent?.delivered).toBe(true);
    expect(capturedEvent?.deliveryStatus).toBe("delivered");
  });

  it("uses workflow delivery truth when the runner summary reports delivery success", async () => {
    const store = await makeStorePath();
    let capturedEvent:
      | {
          status?: string;
          delivered?: boolean;
          deliveryStatus?: string;
          workflowDelivered?: boolean;
          workflowDeliveryStatus?: string;
        }
      | undefined;
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({
        status: "ok" as const,
        delivered: false,
        summary: ["Email: sent", "Telegram: sent"].join("\n"),
      })),
      onEvent: (evt) => {
        if (evt.action === "finished") {
          capturedEvent = {
            status: evt.status,
            delivered: evt.delivered,
            deliveryStatus: evt.deliveryStatus,
            workflowDelivered: evt.workflowDelivered,
            workflowDeliveryStatus: evt.workflowDeliveryStatus,
          };
        }
      },
    });

    await cron.start();
    try {
      const job = await cron.add(buildIsolatedAgentTurnJob("workflow-delivery-success"));
      vi.setSystemTime(new Date(job.state.nextRunAtMs! + 5));
      await vi.runOnlyPendingTimersAsync();

      await vi.waitFor(() => expect(capturedEvent?.status).toBe("ok"));

      const updated = (await cron.list({ includeDisabled: true })).find(
        (entry) => entry.id === job.id,
      );
      expect(updated?.state.lastStatus).toBe("ok");
      expect(updated?.state.lastRunStatus).toBe("ok");
      expect(updated?.state.lastDelivered).toBe(true);
      expect(updated?.state.lastDeliveryStatus).toBe("delivered");
      expect(updated?.state.lastWorkflowDelivered).toBe(true);
      expect(updated?.state.lastWorkflowDeliveryStatus).toBe("email_then_telegram");
      expect(capturedEvent?.delivered).toBe(true);
      expect(capturedEvent?.deliveryStatus).toBe("delivered");
      expect(capturedEvent?.workflowDelivered).toBe(true);
      expect(capturedEvent?.workflowDeliveryStatus).toBe("email_then_telegram");
    } finally {
      cron.stop();
    }
  });

  it("persists workflow failure metadata when the runner reports an ok status with a failed summary", async () => {
    const store = await makeStorePath();
    let capturedEvent:
      | {
          status?: string;
          workflowStatus?: string;
          workflowFailureCode?: string;
          workflowExitCode?: number;
          workflowDeliveryStatus?: string;
        }
      | undefined;
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({
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
      })),
      onEvent: (evt) => {
        if (evt.action === "finished") {
          capturedEvent = {
            status: evt.status,
            workflowStatus: evt.workflowStatus,
            workflowFailureCode: evt.workflowFailureCode,
            workflowExitCode: evt.workflowExitCode,
            workflowDeliveryStatus: evt.workflowDeliveryStatus,
          };
        }
      },
    });

    await cron.start();
    try {
      const job = await cron.add(buildIsolatedAgentTurnJob("workflow-summary-failure"));
      vi.setSystemTime(new Date(job.state.nextRunAtMs! + 5));
      await vi.runOnlyPendingTimersAsync();

      await vi.waitFor(() => expect(capturedEvent?.status).toBe("error"));

      const updated = (await cron.list({ includeDisabled: true })).find(
        (entry) => entry.id === job.id,
      );
      expect(updated?.state.lastStatus).toBe("error");
      expect(updated?.state.lastRunStatus).toBe("error");
      expect(updated?.state.lastWorkflowStatus).toBe("failed");
      expect(updated?.state.lastWorkflowFailureCode).toBe("MAIL_APP_TIMEOUT");
      expect(updated?.state.lastWorkflowExitCode).toBe(1);
      expect(updated?.state.lastWorkflowDelivered).toBe(false);
      expect(updated?.state.lastWorkflowDeliveryStatus).toBe("email_failed_telegram_sent");
      expect(capturedEvent?.workflowStatus).toBe("failed");
      expect(capturedEvent?.workflowFailureCode).toBe("MAIL_APP_TIMEOUT");
      expect(capturedEvent?.workflowExitCode).toBe(1);
      expect(capturedEvent?.workflowDeliveryStatus).toBe("email_failed_telegram_sent");
    } finally {
      cron.stop();
    }
  });
});
