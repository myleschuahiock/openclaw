import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import type {
  CodexCliCredential,
  MiniMaxCliCredential,
  QwenCliCredential,
} from "../cli-credentials.js";
import { resolveApiKeyForProfile } from "./oauth.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore } from "./types.js";

type RefreshedOAuthApiKey = {
  apiKey: string;
  newCredentials: OAuthCredentials;
};

const { getOAuthApiKeyMock } = vi.hoisted(() => ({
  getOAuthApiKeyMock: vi.fn<
    (provider: string, credentials: OAuthCredentials) => Promise<RefreshedOAuthApiKey>
  >(async () => {
    throw new Error("Failed to extract accountId from token");
  }),
}));
const {
  readCodexCliCredentialsCachedMock,
  readQwenCliCredentialsCachedMock,
  readMiniMaxCliCredentialsCachedMock,
} = vi.hoisted(() => ({
  readCodexCliCredentialsCachedMock: vi.fn<() => CodexCliCredential | null>(() => null),
  readQwenCliCredentialsCachedMock: vi.fn<() => QwenCliCredential | null>(() => null),
  readMiniMaxCliCredentialsCachedMock: vi.fn<() => MiniMaxCliCredential | null>(() => null),
}));

vi.mock("@mariozechner/pi-ai/oauth", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai/oauth")>(
    "@mariozechner/pi-ai/oauth",
  );
  return {
    ...actual,
    getOAuthApiKey: getOAuthApiKeyMock,
    getOAuthProviders: () => [
      { id: "openai-codex", envApiKey: "OPENAI_API_KEY", oauthTokenEnv: "OPENAI_OAUTH_TOKEN" }, // pragma: allowlist secret
      { id: "anthropic", envApiKey: "ANTHROPIC_API_KEY", oauthTokenEnv: "ANTHROPIC_OAUTH_TOKEN" }, // pragma: allowlist secret
    ],
  };
});

vi.mock("../cli-credentials.js", () => ({
  readCodexCliCredentialsCached: readCodexCliCredentialsCachedMock,
  readQwenCliCredentialsCached: readQwenCliCredentialsCachedMock,
  readMiniMaxCliCredentialsCached: readMiniMaxCliCredentialsCachedMock,
}));

function createExpiredOauthStore(params: {
  profileId: string;
  provider: string;
  access?: string;
}): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [params.profileId]: {
        type: "oauth",
        provider: params.provider,
        access: params.access ?? "cached-access-token",
        refresh: "refresh-token",
        expires: Date.now() - 60_000,
      },
    },
  };
}

describe("resolveApiKeyForProfile openai-codex refresh fallback", () => {
  const envSnapshot = captureEnv([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
  ]);
  let tempRoot = "";
  let agentDir = "";

  beforeEach(async () => {
    getOAuthApiKeyMock.mockReset().mockImplementation(async () => {
      throw new Error("Failed to extract accountId from token");
    });
    readCodexCliCredentialsCachedMock.mockReset().mockReturnValue(null);
    readQwenCliCredentialsCachedMock.mockReset().mockReturnValue(null);
    readMiniMaxCliCredentialsCachedMock.mockReset().mockReturnValue(null);
    clearRuntimeAuthProfileStoreSnapshots();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-refresh-fallback-"));
    agentDir = path.join(tempRoot, "agents", "main", "agent");
    await fs.mkdir(agentDir, { recursive: true });
    process.env.OPENCLAW_STATE_DIR = tempRoot;
    process.env.OPENCLAW_AGENT_DIR = agentDir;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(async () => {
    clearRuntimeAuthProfileStoreSnapshots();
    envSnapshot.restore();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("falls back to cached access token when openai-codex refresh fails on accountId extraction", async () => {
    const profileId = "openai-codex:default";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
      }),
      agentDir,
    );

    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(agentDir),
      profileId,
      agentDir,
    });

    expect(result).toEqual({
      apiKey: "cached-access-token", // pragma: allowlist secret
      provider: "openai-codex",
      email: undefined,
    });
    expect(getOAuthApiKeyMock).toHaveBeenCalledTimes(1);
  });

  it("keeps throwing for non-codex providers on the same refresh error", async () => {
    const profileId = "anthropic:default";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "anthropic",
      }),
      agentDir,
    );

    await expect(
      resolveApiKeyForProfile({
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
      }),
    ).rejects.toThrow(/OAuth token refresh failed for anthropic/);
  });

  it("does not use fallback for unrelated openai-codex refresh errors", async () => {
    const profileId = "openai-codex:default";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
      }),
      agentDir,
    );
    getOAuthApiKeyMock.mockImplementationOnce(async () => {
      throw new Error("invalid_grant");
    });

    await expect(
      resolveApiKeyForProfile({
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
      }),
    ).rejects.toThrow(/OAuth token refresh failed for openai-codex/);
  });

  it("rehydrates from Codex CLI credentials and retries once when the refresh token was reused", async () => {
    const profileId = "openai-codex:default";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
        access: "stale-access-token",
      }),
      agentDir,
    );
    readCodexCliCredentialsCachedMock
      .mockImplementationOnce(() => null)
      .mockImplementationOnce(() => null)
      .mockReturnValue({
        type: "oauth",
        provider: "openai-codex",
        access: "replacement-access-token",
        refresh: "replacement-refresh-token",
        expires: Date.now() - 10_000,
        accountId: "acct-replacement",
      });
    getOAuthApiKeyMock
      .mockImplementationOnce(async () => {
        throw new Error('{"code":"refresh_token_reused"}');
      })
      .mockImplementationOnce(async () => ({
        apiKey: "retried-access-token",
        newCredentials: {
          access: "retried-access-token",
          refresh: "retried-refresh-token",
          expires: Date.now() + 60_000,
          accountId: "acct-final",
        },
      }));

    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(agentDir),
      profileId,
      agentDir,
    });

    expect(result).toEqual({
      apiKey: "retried-access-token",
      provider: "openai-codex",
      email: undefined,
    });
    expect(getOAuthApiKeyMock).toHaveBeenCalledTimes(2);
    const persisted = ensureAuthProfileStore(agentDir).profiles[profileId];
    expect(persisted).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
      access: "retried-access-token",
      refresh: "retried-refresh-token",
      accountId: "acct-final",
    });
  });

  it("persists recovered credentials before retry when the main-agent refresh token was reused", async () => {
    const profileId = "openai-codex:default";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
        access: "main-stale-access-token",
      }),
    );
    readCodexCliCredentialsCachedMock
      .mockImplementationOnce(() => null)
      .mockImplementationOnce(() => null)
      .mockReturnValue({
        type: "oauth",
        provider: "openai-codex",
        access: "main-replacement-access-token",
        refresh: "main-replacement-refresh-token",
        expires: Date.now() - 10_000,
        accountId: "acct-main-replacement",
      });
    getOAuthApiKeyMock
      .mockImplementationOnce(async () => {
        throw new Error('{"code":"refresh_token_reused"}');
      })
      .mockImplementationOnce(async () => ({
        apiKey: "main-retried-access-token",
        newCredentials: {
          access: "main-retried-access-token",
          refresh: "main-retried-refresh-token",
          expires: Date.now() + 60_000,
          accountId: "acct-main-final",
        },
      }));

    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(),
      profileId,
    });

    expect(result).toEqual({
      apiKey: "main-retried-access-token",
      provider: "openai-codex",
      email: undefined,
    });
    expect(getOAuthApiKeyMock).toHaveBeenCalledTimes(2);
    const persisted = ensureAuthProfileStore().profiles[profileId];
    expect(persisted).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
      access: "main-retried-access-token",
      refresh: "main-retried-refresh-token",
      accountId: "acct-main-final",
    });
  });

  it("keeps throwing when refresh_token_reused has no replacement credential to recover from", async () => {
    const profileId = "openai-codex:default";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
      }),
      agentDir,
    );
    getOAuthApiKeyMock.mockImplementationOnce(async () => {
      throw new Error('{"code":"refresh_token_reused"}');
    });

    await expect(
      resolveApiKeyForProfile({
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
      }),
    ).rejects.toThrow(/OAuth token refresh failed for openai-codex/);
  });
});
