import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_CLI_PROFILE_ID } from "./auth-profiles/constants.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";

const mocks = vi.hoisted(() => ({
  readCodexCliCredentialsCached: vi.fn(),
  readQwenCliCredentialsCached: vi.fn(),
  readMiniMaxCliCredentialsCached: vi.fn(),
}));

vi.mock("./cli-credentials.js", () => ({
  readCodexCliCredentialsCached: mocks.readCodexCliCredentialsCached,
  readQwenCliCredentialsCached: mocks.readQwenCliCredentialsCached,
  readMiniMaxCliCredentialsCached: mocks.readMiniMaxCliCredentialsCached,
}));

const { syncExternalCliCredentials } = await import("./auth-profiles/external-cli-sync.js");

describe("auth profile external CLI sync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T01:30:00Z"));
    mocks.readCodexCliCredentialsCached.mockReset().mockReturnValue(null);
    mocks.readQwenCliCredentialsCached.mockReset().mockReturnValue(null);
    mocks.readMiniMaxCliCredentialsCached.mockReset().mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("syncs Codex CLI credentials into openai-codex:default without restoring the deprecated CLI profile id", () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {},
    };
    mocks.readCodexCliCredentialsCached.mockReturnValue({
      type: "oauth",
      provider: "openai-codex",
      access: "codex-access",
      refresh: "codex-refresh",
      expires: Date.now() + 60 * 60 * 1000,
      accountId: "acct-123",
    });

    const mutated = syncExternalCliCredentials(store);

    expect(mutated).toBe(true);
    expect(store.profiles["openai-codex:default"]).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
      access: "codex-access",
      refresh: "codex-refresh",
      accountId: "acct-123",
    });
    expect(store.profiles[CODEX_CLI_PROFILE_ID]).toBeUndefined();
  });
});
