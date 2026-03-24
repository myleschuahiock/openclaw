import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import { drainSystemEvents } from "../infra/system-events.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
  withGatewayServer,
} from "./test-helpers.js";

const hoisted = vi.hoisted(() => {
  const cronInstances: Array<{
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    add: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
    wake: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    listPage: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
  }> = [];
  let cronJobSeq = 1;

  class CronServiceMock {
    start = vi.fn(async () => {});
    stop = vi.fn();
    add = vi.fn(async (input: Record<string, unknown>) => ({
      id: `cron-job-${cronJobSeq++}`,
      ...input,
      state: { nextRunAtMs: Date.parse("2026-12-31T00:00:00.000Z") },
    }));
    update = vi.fn(async (_id: string, patch: Record<string, unknown>) => ({
      id: "updated-cron-job",
      ...patch,
    }));
    remove = vi.fn(async () => ({ ok: true as const, removed: true as const }));
    run = vi.fn(async () => ({ ok: true as const, ran: true as const }));
    wake = vi.fn(() => ({ ok: true as const }));
    list = vi.fn(async () => []);
    listPage = vi.fn(async () => ({
      jobs: [],
      total: 0,
      offset: 0,
      limit: 0,
      hasMore: false,
      nextOffset: null,
    }));
    status = vi.fn(async () => ({
      enabled: true,
      storePath: "/tmp/cron.json",
      jobs: 0,
      nextWakeAtMs: null,
    }));
    constructor() {
      cronInstances.push(this);
    }
  }

  const browserStop = vi.fn(async () => {});
  const startBrowserControlServerIfEnabled = vi.fn(async () => ({
    stop: browserStop,
  }));

  const heartbeatStop = vi.fn();
  const heartbeatUpdateConfig = vi.fn();
  const startHeartbeatRunner = vi.fn(() => ({
    stop: heartbeatStop,
    updateConfig: heartbeatUpdateConfig,
  }));

  const startGmailWatcher = vi.fn(async () => ({ started: true }));
  const stopGmailWatcher = vi.fn(async () => {});

  const providerManager = {
    getRuntimeSnapshot: vi.fn(() => ({
      providers: {
        whatsapp: {
          running: false,
          connected: false,
          reconnectAttempts: 0,
          lastConnectedAt: null,
          lastDisconnect: null,
          lastMessageAt: null,
          lastEventAt: null,
          lastError: null,
        },
        telegram: {
          running: false,
          lastStartAt: null,
          lastStopAt: null,
          lastError: null,
          mode: null,
        },
        discord: {
          running: false,
          lastStartAt: null,
          lastStopAt: null,
          lastError: null,
        },
        slack: {
          running: false,
          lastStartAt: null,
          lastStopAt: null,
          lastError: null,
        },
        signal: {
          running: false,
          lastStartAt: null,
          lastStopAt: null,
          lastError: null,
          baseUrl: null,
        },
        imessage: {
          running: false,
          lastStartAt: null,
          lastStopAt: null,
          lastError: null,
          cliPath: null,
          dbPath: null,
        },
        msteams: {
          running: false,
          lastStartAt: null,
          lastStopAt: null,
          lastError: null,
        },
      },
      providerAccounts: {
        whatsapp: {},
        telegram: {},
        discord: {},
        slack: {},
        signal: {},
        imessage: {},
        msteams: {},
      },
    })),
    startChannels: vi.fn(async () => {}),
    startChannel: vi.fn(async () => {}),
    stopChannel: vi.fn(async () => {}),
    markChannelLoggedOut: vi.fn(),
  };

  const createChannelManager = vi.fn(() => providerManager);

  const reloaderStop = vi.fn(async () => {});
  let onHotReload: ((plan: unknown, nextConfig: unknown) => Promise<void>) | null = null;
  let onRestart: ((plan: unknown, nextConfig: unknown) => void) | null = null;

  const startGatewayConfigReloader = vi.fn(
    (opts: { onHotReload: typeof onHotReload; onRestart: typeof onRestart }) => {
      onHotReload = opts.onHotReload;
      onRestart = opts.onRestart;
      return { stop: reloaderStop };
    },
  );

  return {
    CronService: CronServiceMock,
    cronInstances,
    browserStop,
    startBrowserControlServerIfEnabled,
    heartbeatStop,
    heartbeatUpdateConfig,
    startHeartbeatRunner,
    startGmailWatcher,
    stopGmailWatcher,
    providerManager,
    createChannelManager,
    startGatewayConfigReloader,
    reloaderStop,
    getOnHotReload: () => onHotReload,
    getOnRestart: () => onRestart,
  };
});

vi.mock("../cron/service.js", () => ({
  CronService: hoisted.CronService,
}));

vi.mock("./server-browser.js", () => ({
  startBrowserControlServerIfEnabled: hoisted.startBrowserControlServerIfEnabled,
}));

vi.mock("../infra/heartbeat-runner.js", () => ({
  startHeartbeatRunner: hoisted.startHeartbeatRunner,
}));

vi.mock("../hooks/gmail-watcher.js", () => ({
  startGmailWatcher: hoisted.startGmailWatcher,
  stopGmailWatcher: hoisted.stopGmailWatcher,
}));

vi.mock("./server-channels.js", () => ({
  createChannelManager: hoisted.createChannelManager,
}));

vi.mock("./config-reload.js", () => ({
  startGatewayConfigReloader: hoisted.startGatewayConfigReloader,
}));

installGatewayTestHooks({ scope: "suite" });

describe("gateway hot reload", () => {
  let prevSkipChannels: string | undefined;
  let prevSkipGmail: string | undefined;
  let prevSkipProviders: string | undefined;
  let prevOpenAiApiKey: string | undefined;

  beforeEach(() => {
    prevSkipChannels = process.env.OPENCLAW_SKIP_CHANNELS;
    prevSkipGmail = process.env.OPENCLAW_SKIP_GMAIL_WATCHER;
    prevSkipProviders = process.env.OPENCLAW_SKIP_PROVIDERS;
    prevOpenAiApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENCLAW_SKIP_CHANNELS = "0";
    delete process.env.OPENCLAW_SKIP_GMAIL_WATCHER;
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
  });

  afterEach(() => {
    if (prevSkipChannels === undefined) {
      delete process.env.OPENCLAW_SKIP_CHANNELS;
    } else {
      process.env.OPENCLAW_SKIP_CHANNELS = prevSkipChannels;
    }
    if (prevSkipGmail === undefined) {
      delete process.env.OPENCLAW_SKIP_GMAIL_WATCHER;
    } else {
      process.env.OPENCLAW_SKIP_GMAIL_WATCHER = prevSkipGmail;
    }
    if (prevSkipProviders === undefined) {
      delete process.env.OPENCLAW_SKIP_PROVIDERS;
    } else {
      process.env.OPENCLAW_SKIP_PROVIDERS = prevSkipProviders;
    }
    if (prevOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = prevOpenAiApiKey;
    }
  });

  async function writeEnvRefConfig() {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      throw new Error("OPENCLAW_CONFIG_PATH is not set");
    }
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                models: [],
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  async function writeDisabledSurfaceRefConfig() {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      throw new Error("OPENCLAW_CONFIG_PATH is not set");
    }
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          channels: {
            telegram: {
              enabled: false,
              botToken: { source: "env", provider: "default", id: "DISABLED_TELEGRAM_STARTUP_REF" },
            },
          },
          tools: {
            web: {
              search: {
                enabled: false,
                apiKey: {
                  source: "env",
                  provider: "default",
                  id: "DISABLED_WEB_SEARCH_STARTUP_REF",
                },
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  async function writeGatewayTokenRefConfig() {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      throw new Error("OPENCLAW_CONFIG_PATH is not set");
    }
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          secrets: {
            providers: {
              default: { source: "env" },
            },
          },
          gateway: {
            auth: {
              mode: "token",
              token: { source: "env", provider: "default", id: "MISSING_STARTUP_GW_TOKEN" },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  async function writeAuthProfileEnvRefStore() {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("OPENCLAW_STATE_DIR is not set");
    }
    const authStorePath = path.join(stateDir, "agents", "main", "agent", "auth-profiles.json");
    await fs.mkdir(path.dirname(authStorePath), { recursive: true });
    await fs.writeFile(
      authStorePath,
      `${JSON.stringify(
        {
          version: 1,
          profiles: {
            missing: {
              type: "api_key",
              provider: "openai",
              keyRef: { source: "env", provider: "default", id: "MISSING_OPENCLAW_AUTH_REF" },
            },
          },
          selectedProfileId: "missing",
          lastUsedProfileByModel: {},
          usageStats: {},
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  async function removeMainAuthProfileStore() {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      return;
    }
    const authStorePath = path.join(stateDir, "agents", "main", "agent", "auth-profiles.json");
    await fs.rm(authStorePath, { force: true });
  }

  it("applies hot reload actions and emits restart signal", async () => {
    await withGatewayServer(async () => {
      const onHotReload = hoisted.getOnHotReload();
      expect(onHotReload).toBeTypeOf("function");

      const nextConfig = {
        hooks: {
          enabled: true,
          token: "secret",
          gmail: { account: "me@example.com" },
        },
        cron: { enabled: true, store: "/tmp/cron.json" },
        agents: { defaults: { heartbeat: { every: "1m" }, maxConcurrent: 2 } },
        browser: { enabled: true },
        web: { enabled: true },
        channels: {
          telegram: { botToken: "token" },
          discord: { token: "token" },
          signal: { account: "+15550000000" },
          imessage: { enabled: true },
        },
      };

      await onHotReload?.(
        {
          changedPaths: [
            "hooks.gmail.account",
            "cron.enabled",
            "agents.defaults.heartbeat.every",
            "browser.enabled",
            "web.enabled",
            "channels.telegram.botToken",
            "channels.discord.token",
            "channels.signal.account",
            "channels.imessage.enabled",
          ],
          restartGateway: false,
          restartReasons: [],
          hotReasons: ["web.enabled"],
          reloadHooks: true,
          restartGmailWatcher: true,
          restartBrowserControl: true,
          restartCron: true,
          restartHeartbeat: true,
          restartChannels: new Set(["whatsapp", "telegram", "discord", "signal", "imessage"]),
          noopPaths: [],
        },
        nextConfig,
      );

      expect(hoisted.stopGmailWatcher).toHaveBeenCalled();
      expect(hoisted.startGmailWatcher).toHaveBeenCalledWith(nextConfig);

      expect(hoisted.browserStop).toHaveBeenCalledTimes(1);
      expect(hoisted.startBrowserControlServerIfEnabled).toHaveBeenCalledTimes(2);

      expect(hoisted.startHeartbeatRunner).toHaveBeenCalledTimes(1);
      expect(hoisted.heartbeatUpdateConfig).toHaveBeenCalledTimes(1);
      expect(hoisted.heartbeatUpdateConfig).toHaveBeenCalledWith(nextConfig);

      expect(hoisted.cronInstances.length).toBe(2);
      expect(hoisted.cronInstances[0].stop).toHaveBeenCalledTimes(1);
      expect(hoisted.cronInstances[1].start).toHaveBeenCalledTimes(1);

      expect(hoisted.providerManager.stopChannel).toHaveBeenCalledTimes(5);
      expect(hoisted.providerManager.startChannel).toHaveBeenCalledTimes(5);
      expect(hoisted.providerManager.stopChannel).toHaveBeenCalledWith("whatsapp");
      expect(hoisted.providerManager.startChannel).toHaveBeenCalledWith("whatsapp");
      expect(hoisted.providerManager.stopChannel).toHaveBeenCalledWith("telegram");
      expect(hoisted.providerManager.startChannel).toHaveBeenCalledWith("telegram");
      expect(hoisted.providerManager.stopChannel).toHaveBeenCalledWith("discord");
      expect(hoisted.providerManager.startChannel).toHaveBeenCalledWith("discord");
      expect(hoisted.providerManager.stopChannel).toHaveBeenCalledWith("signal");
      expect(hoisted.providerManager.startChannel).toHaveBeenCalledWith("signal");
      expect(hoisted.providerManager.stopChannel).toHaveBeenCalledWith("imessage");
      expect(hoisted.providerManager.startChannel).toHaveBeenCalledWith("imessage");

      const onRestart = hoisted.getOnRestart();
      expect(onRestart).toBeTypeOf("function");

      const signalSpy = vi.fn();
      process.once("SIGUSR1", signalSpy);

      const restartResult = onRestart?.(
        {
          changedPaths: ["gateway.port"],
          restartGateway: true,
          restartReasons: ["gateway.port"],
          hotReasons: [],
          reloadHooks: false,
          restartGmailWatcher: false,
          restartBrowserControl: false,
          restartCron: false,
          restartHeartbeat: false,
          restartChannels: new Set(),
          noopPaths: [],
        },
        {},
      );
      await Promise.resolve(restartResult);

      expect(signalSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("routes cron RPCs through the reloaded cron service after hot reload", async () => {
    const { server, ws } = await startServerWithClient();
    const baseline = hoisted.cronInstances.length;
    try {
      await connectOk(ws);
      const onHotReload = hoisted.getOnHotReload();
      expect(onHotReload).toBeTypeOf("function");

      await onHotReload?.(
        {
          changedPaths: ["cron.enabled"],
          restartGateway: false,
          restartReasons: [],
          hotReasons: [],
          reloadHooks: false,
          restartGmailWatcher: false,
          restartBrowserControl: false,
          restartCron: true,
          restartHeartbeat: false,
          restartChannels: new Set(),
          noopPaths: [],
        },
        { cron: { enabled: true, store: "/tmp/reloaded-cron.json" } },
      );

      expect(hoisted.cronInstances.length).toBe(baseline + 1);
      const original = hoisted.cronInstances[baseline - 1];
      const reloaded = hoisted.cronInstances[baseline];

      const result = await rpcReq<Record<string, unknown>>(ws, "cron.add", {
        name: "reload-cron-rpc-smoke",
        schedule: { kind: "at", at: "2026-12-31T00:00:00.000Z" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "smoke" },
        delivery: { mode: "none", channel: "last" },
      });

      expect(result.ok).toBe(true);
      expect(original?.add).not.toHaveBeenCalled();
      expect(reloaded?.add).toHaveBeenCalledTimes(1);
    } finally {
      ws.close();
      await server.close();
    }
  });

  it("stops the reloaded cron service on gateway shutdown", async () => {
    const baseline = hoisted.cronInstances.length;

    await withGatewayServer(async () => {
      const onHotReload = hoisted.getOnHotReload();
      expect(onHotReload).toBeTypeOf("function");

      await onHotReload?.(
        {
          changedPaths: ["cron.enabled"],
          restartGateway: false,
          restartReasons: [],
          hotReasons: [],
          reloadHooks: false,
          restartGmailWatcher: false,
          restartBrowserControl: false,
          restartCron: true,
          restartHeartbeat: false,
          restartChannels: new Set(),
          noopPaths: [],
        },
        { cron: { enabled: true, store: "/tmp/reloaded-cron.json" } },
      );
    });

    const instances = hoisted.cronInstances.slice(baseline);
    expect(instances.length).toBe(2);
    expect(instances[0]?.stop).toHaveBeenCalledTimes(1);
    expect(instances[1]?.stop).toHaveBeenCalledTimes(1);
  });

  it("stops the reloaded browser control on gateway shutdown", async () => {
    const baseline = hoisted.browserStop.mock.calls.length;

    await withGatewayServer(async () => {
      const onHotReload = hoisted.getOnHotReload();
      expect(onHotReload).toBeTypeOf("function");

      await onHotReload?.(
        {
          changedPaths: ["browser.enabled"],
          restartGateway: false,
          restartReasons: [],
          hotReasons: [],
          reloadHooks: false,
          restartGmailWatcher: false,
          restartBrowserControl: true,
          restartCron: false,
          restartHeartbeat: false,
          restartChannels: new Set(),
          noopPaths: [],
        },
        { browser: { enabled: true }, web: { enabled: true } },
      );
    });

    expect(hoisted.browserStop.mock.calls.length - baseline).toBe(2);
  });

  it("fails startup when required secret refs are unresolved", async () => {
    await writeEnvRefConfig();
    delete process.env.OPENAI_API_KEY;
    await expect(withGatewayServer(async () => {})).rejects.toThrow(
      "Startup failed: required secrets are unavailable",
    );
  });

  it("allows startup when unresolved refs exist only on disabled surfaces", async () => {
    await writeDisabledSurfaceRefConfig();
    delete process.env.DISABLED_TELEGRAM_STARTUP_REF;
    delete process.env.DISABLED_WEB_SEARCH_STARTUP_REF;
    await expect(withGatewayServer(async () => {})).resolves.toBeUndefined();
  });

  it("honors startup auth overrides before secret preflight gating", async () => {
    await writeGatewayTokenRefConfig();
    delete process.env.MISSING_STARTUP_GW_TOKEN;
    await expect(
      withGatewayServer(async () => {}, {
        serverOptions: {
          auth: {
            mode: "password",
            password: "override-password", // pragma: allowlist secret
          },
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("fails startup when auth-profile secret refs are unresolved", async () => {
    await writeAuthProfileEnvRefStore();
    delete process.env.MISSING_OPENCLAW_AUTH_REF;
    try {
      await expect(withGatewayServer(async () => {})).rejects.toThrow(
        'Environment variable "MISSING_OPENCLAW_AUTH_REF" is missing or empty.',
      );
    } finally {
      await removeMainAuthProfileStore();
    }
  });

  it("emits one-shot degraded and recovered system events during secret reload transitions", async () => {
    await writeEnvRefConfig();
    process.env.OPENAI_API_KEY = "sk-startup"; // pragma: allowlist secret

    await withGatewayServer(async () => {
      const onHotReload = hoisted.getOnHotReload();
      expect(onHotReload).toBeTypeOf("function");
      const sessionKey = resolveMainSessionKeyFromConfig();
      const plan = {
        changedPaths: ["models.providers.openai.apiKey"],
        restartGateway: false,
        restartReasons: [],
        hotReasons: ["models.providers.openai.apiKey"],
        reloadHooks: false,
        restartGmailWatcher: false,
        restartBrowserControl: false,
        restartCron: false,
        restartHeartbeat: false,
        restartChannels: new Set(),
        noopPaths: [],
      };
      const nextConfig = {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
              models: [],
            },
          },
        },
      };

      delete process.env.OPENAI_API_KEY;
      await expect(onHotReload?.(plan, nextConfig)).rejects.toThrow(
        'Environment variable "OPENAI_API_KEY" is missing or empty.',
      );
      const degradedEvents = drainSystemEvents(sessionKey);
      expect(degradedEvents.some((event) => event.includes("[SECRETS_RELOADER_DEGRADED]"))).toBe(
        true,
      );

      await expect(onHotReload?.(plan, nextConfig)).rejects.toThrow(
        'Environment variable "OPENAI_API_KEY" is missing or empty.',
      );
      expect(drainSystemEvents(sessionKey)).toEqual([]);

      process.env.OPENAI_API_KEY = "sk-recovered"; // pragma: allowlist secret
      await expect(onHotReload?.(plan, nextConfig)).resolves.toBeUndefined();
      const recoveredEvents = drainSystemEvents(sessionKey);
      expect(recoveredEvents.some((event) => event.includes("[SECRETS_RELOADER_RECOVERED]"))).toBe(
        true,
      );
    });
  });

  it("serves secrets.reload immediately after startup without race failures", async () => {
    await writeEnvRefConfig();
    process.env.OPENAI_API_KEY = "sk-startup"; // pragma: allowlist secret
    const { server, ws } = await startServerWithClient();
    try {
      await connectOk(ws);
      const [first, second] = await Promise.all([
        rpcReq<{ warningCount: number }>(ws, "secrets.reload", {}),
        rpcReq<{ warningCount: number }>(ws, "secrets.reload", {}),
      ]);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
    } finally {
      ws.close();
      await server.close();
    }
  });
});

describe("gateway agents", () => {
  it("lists configured agents via agents.list RPC", async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);
    const res = await rpcReq<{ agents: Array<{ id: string }> }>(ws, "agents.list", {});
    expect(res.ok).toBe(true);
    expect(res.payload?.agents.map((agent) => agent.id)).toContain("main");
    ws.close();
    await server.close();
  });
});
