import fs from "node:fs";
import path from "node:path";
import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { resolveStateDir } from "../../config/paths.js";
import { resolveOAuthPath } from "../../config/paths.js";
import { withFileLock } from "../../infra/file-lock.js";
import { loadJsonFile, saveJsonFile } from "../../infra/json-file.js";
import { AUTH_STORE_LOCK_OPTIONS, AUTH_STORE_VERSION, log } from "./constants.js";
import { syncExternalCliCredentials } from "./external-cli-sync.js";
import { ensureAuthStoreFile, resolveAuthStorePath, resolveLegacyAuthStorePath } from "./paths.js";
import type { AuthProfileCredential, AuthProfileStore, ProfileUsageStats } from "./types.js";

type LegacyAuthStore = Record<string, AuthProfileCredential>;
type CredentialRejectReason = "non_object" | "invalid_type" | "missing_provider";
type RejectedCredentialEntry = { key: string; reason: CredentialRejectReason };
type LoadAuthProfileStoreOptions = {
  allowKeychainPrompt?: boolean;
  readOnly?: boolean;
};
type StoredOAuthCredential = Extract<AuthProfileCredential, { type: "oauth" }>;
type MergeAuthProfileStoresResult = {
  store: AuthProfileStore;
  healedProfileIds: string[];
};

const AUTH_PROFILE_TYPES = new Set<AuthProfileCredential["type"]>(["api_key", "oauth", "token"]);

const runtimeAuthStoreSnapshots = new Map<string, AuthProfileStore>();

function resolveRuntimeStoreKey(agentDir?: string): string {
  return resolveAuthStorePath(agentDir);
}

function cloneAuthProfileStore(store: AuthProfileStore): AuthProfileStore {
  return structuredClone(store);
}

function resolveRuntimeAuthProfileStore(agentDir?: string): AuthProfileStore | null {
  if (runtimeAuthStoreSnapshots.size === 0) {
    return null;
  }

  const mainKey = resolveRuntimeStoreKey(undefined);
  const requestedKey = resolveRuntimeStoreKey(agentDir);
  const mainStore = runtimeAuthStoreSnapshots.get(mainKey);
  const requestedStore = runtimeAuthStoreSnapshots.get(requestedKey);

  if (!agentDir || requestedKey === mainKey) {
    if (!mainStore) {
      return null;
    }
    return cloneAuthProfileStore(mainStore);
  }

  if (mainStore && requestedStore) {
    return mergeAuthProfileStores(
      cloneAuthProfileStore(mainStore),
      cloneAuthProfileStore(requestedStore),
    );
  }
  if (requestedStore) {
    return cloneAuthProfileStore(requestedStore);
  }
  if (mainStore) {
    return cloneAuthProfileStore(mainStore);
  }

  return null;
}

export function replaceRuntimeAuthProfileStoreSnapshots(
  entries: Array<{ agentDir?: string; store: AuthProfileStore }>,
): void {
  runtimeAuthStoreSnapshots.clear();
  for (const entry of entries) {
    runtimeAuthStoreSnapshots.set(
      resolveRuntimeStoreKey(entry.agentDir),
      cloneAuthProfileStore(entry.store),
    );
  }
}

export function clearRuntimeAuthProfileStoreSnapshots(): void {
  runtimeAuthStoreSnapshots.clear();
}

export async function updateAuthProfileStoreWithLock(params: {
  agentDir?: string;
  updater: (store: AuthProfileStore) => boolean;
}): Promise<AuthProfileStore | null> {
  const authPath = resolveAuthStorePath(params.agentDir);
  ensureAuthStoreFile(authPath);

  try {
    return await withFileLock(authPath, AUTH_STORE_LOCK_OPTIONS, async () => {
      const store = ensureAuthProfileStore(params.agentDir);
      const shouldSave = params.updater(store);
      if (shouldSave) {
        saveAuthProfileStore(store, params.agentDir);
      }
      return store;
    });
  } catch {
    return null;
  }
}

/**
 * Normalise a raw auth-profiles.json credential entry.
 *
 * The official format uses `type` and (for api_key credentials) `key`.
 * A common mistake — caused by the similarity with the `openclaw.json`
 * `auth.profiles` section which uses `mode` — is to write `mode` instead of
 * `type` and `apiKey` instead of `key`.  Accept both spellings so users don't
 * silently lose their credentials.
 */
function normalizeRawCredentialEntry(raw: Record<string, unknown>): Partial<AuthProfileCredential> {
  const entry = { ...raw } as Record<string, unknown>;
  // mode → type alias (openclaw.json uses "mode"; auth-profiles.json uses "type")
  if (!("type" in entry) && typeof entry["mode"] === "string") {
    entry["type"] = entry["mode"];
  }
  // apiKey → key alias for ApiKeyCredential
  if (!("key" in entry) && typeof entry["apiKey"] === "string") {
    entry["key"] = entry["apiKey"];
  }
  return entry as Partial<AuthProfileCredential>;
}

function parseCredentialEntry(
  raw: unknown,
  fallbackProvider?: string,
): { ok: true; credential: AuthProfileCredential } | { ok: false; reason: CredentialRejectReason } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "non_object" };
  }
  const typed = normalizeRawCredentialEntry(raw as Record<string, unknown>);
  if (!AUTH_PROFILE_TYPES.has(typed.type as AuthProfileCredential["type"])) {
    return { ok: false, reason: "invalid_type" };
  }
  const provider = typed.provider ?? fallbackProvider;
  if (typeof provider !== "string" || provider.trim().length === 0) {
    return { ok: false, reason: "missing_provider" };
  }
  return {
    ok: true,
    credential: {
      ...typed,
      provider,
    } as AuthProfileCredential,
  };
}

function warnRejectedCredentialEntries(source: string, rejected: RejectedCredentialEntry[]): void {
  if (rejected.length === 0) {
    return;
  }
  const reasons = rejected.reduce(
    (acc, current) => {
      acc[current.reason] = (acc[current.reason] ?? 0) + 1;
      return acc;
    },
    {} as Partial<Record<CredentialRejectReason, number>>,
  );
  log.warn("ignored invalid auth profile entries during store load", {
    source,
    dropped: rejected.length,
    reasons,
    keys: rejected.slice(0, 10).map((entry) => entry.key),
  });
}

function coerceLegacyStore(raw: unknown): LegacyAuthStore | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if ("profiles" in record) {
    return null;
  }
  const entries: LegacyAuthStore = {};
  const rejected: RejectedCredentialEntry[] = [];
  for (const [key, value] of Object.entries(record)) {
    const parsed = parseCredentialEntry(value, key);
    if (!parsed.ok) {
      rejected.push({ key, reason: parsed.reason });
      continue;
    }
    entries[key] = parsed.credential;
  }
  warnRejectedCredentialEntries("auth.json", rejected);
  return Object.keys(entries).length > 0 ? entries : null;
}

function coerceAuthStore(raw: unknown): AuthProfileStore | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (!record.profiles || typeof record.profiles !== "object") {
    return null;
  }
  const profiles = record.profiles as Record<string, unknown>;
  const normalized: Record<string, AuthProfileCredential> = {};
  const rejected: RejectedCredentialEntry[] = [];
  for (const [key, value] of Object.entries(profiles)) {
    const parsed = parseCredentialEntry(value);
    if (!parsed.ok) {
      rejected.push({ key, reason: parsed.reason });
      continue;
    }
    normalized[key] = parsed.credential;
  }
  warnRejectedCredentialEntries("auth-profiles.json", rejected);
  const order =
    record.order && typeof record.order === "object"
      ? Object.entries(record.order as Record<string, unknown>).reduce(
          (acc, [provider, value]) => {
            if (!Array.isArray(value)) {
              return acc;
            }
            const list = value
              .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
              .filter(Boolean);
            if (list.length === 0) {
              return acc;
            }
            acc[provider] = list;
            return acc;
          },
          {} as Record<string, string[]>,
        )
      : undefined;
  return {
    version: Number(record.version ?? AUTH_STORE_VERSION),
    profiles: normalized,
    order,
    lastGood:
      record.lastGood && typeof record.lastGood === "object"
        ? (record.lastGood as Record<string, string>)
        : undefined,
    usageStats:
      record.usageStats && typeof record.usageStats === "object"
        ? (record.usageStats as Record<string, ProfileUsageStats>)
        : undefined,
  };
}

function mergeRecord<T>(
  base?: Record<string, T>,
  override?: Record<string, T>,
): Record<string, T> | undefined {
  if (!base && !override) {
    return undefined;
  }
  if (!base) {
    return { ...override };
  }
  if (!override) {
    return { ...base };
  }
  return { ...base, ...override };
}

function isStoredOAuthCredential(
  credential: AuthProfileCredential | undefined,
): credential is StoredOAuthCredential {
  return credential?.type === "oauth";
}

function sameStoredOAuthCredential(
  left: StoredOAuthCredential | undefined,
  right: StoredOAuthCredential | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }
  return (
    left.provider === right.provider &&
    left.access === right.access &&
    left.refresh === right.refresh &&
    left.expires === right.expires &&
    left.email === right.email &&
    left.enterpriseUrl === right.enterpriseUrl &&
    left.projectId === right.projectId &&
    left.accountId === right.accountId &&
    left.clientId === right.clientId
  );
}

function resolveOAuthCredentialCompleteness(credential: StoredOAuthCredential): number {
  let score = 0;
  if (typeof credential.access === "string" && credential.access.trim().length > 0) {
    score += 1;
  }
  if (typeof credential.refresh === "string" && credential.refresh.trim().length > 0) {
    score += 1;
  }
  if (typeof credential.accountId === "string" && credential.accountId.trim().length > 0) {
    score += 1;
  }
  if (typeof credential.enterpriseUrl === "string" && credential.enterpriseUrl.trim().length > 0) {
    score += 1;
  }
  if (typeof credential.projectId === "string" && credential.projectId.trim().length > 0) {
    score += 1;
  }
  return score;
}

function resolveOAuthCredentialExpiry(credential: StoredOAuthCredential): number {
  return typeof credential.expires === "number" && Number.isFinite(credential.expires)
    ? credential.expires
    : Number.NEGATIVE_INFINITY;
}

function compareStoredOAuthCredentialFreshness(
  left: StoredOAuthCredential,
  right: StoredOAuthCredential,
): number {
  const expiryDiff = resolveOAuthCredentialExpiry(left) - resolveOAuthCredentialExpiry(right);
  if (expiryDiff !== 0) {
    return expiryDiff;
  }
  const completenessDiff =
    resolveOAuthCredentialCompleteness(left) - resolveOAuthCredentialCompleteness(right);
  if (completenessDiff !== 0) {
    return completenessDiff;
  }
  return 0;
}

function mergeAuthProfileStoresDetailed(
  base: AuthProfileStore,
  override: AuthProfileStore,
): MergeAuthProfileStoresResult {
  if (
    Object.keys(override.profiles).length === 0 &&
    !override.order &&
    !override.lastGood &&
    !override.usageStats
  ) {
    return {
      store: base,
      healedProfileIds: [],
    };
  }

  const profiles = { ...base.profiles };
  const healedProfileIds: string[] = [];
  for (const [profileId, overrideCredential] of Object.entries(override.profiles)) {
    const baseCredential = profiles[profileId];
    if (
      isStoredOAuthCredential(baseCredential) &&
      isStoredOAuthCredential(overrideCredential) &&
      baseCredential.provider === overrideCredential.provider &&
      compareStoredOAuthCredentialFreshness(baseCredential, overrideCredential) > 0
    ) {
      profiles[profileId] = baseCredential;
      healedProfileIds.push(profileId);
      continue;
    }
    profiles[profileId] = overrideCredential;
  }

  return {
    store: {
      version: Math.max(base.version, override.version ?? base.version),
      profiles,
      order: mergeRecord(base.order, override.order),
      lastGood: mergeRecord(base.lastGood, override.lastGood),
      usageStats: mergeRecord(base.usageStats, override.usageStats),
    },
    healedProfileIds,
  };
}

function mergeAuthProfileStores(
  base: AuthProfileStore,
  override: AuthProfileStore,
): AuthProfileStore {
  return mergeAuthProfileStoresDetailed(base, override).store;
}

function loadPersistedAuthProfileStore(agentDir?: string): AuthProfileStore {
  return (
    loadCoercedStore(resolveAuthStorePath(agentDir)) ?? {
      version: AUTH_STORE_VERSION,
      profiles: {},
    }
  );
}

function collectUpdatedOAuthProfiles(params: {
  before: Record<string, StoredOAuthCredential>;
  after: AuthProfileStore;
}): Array<{ profileId: string; credential: StoredOAuthCredential }> {
  const updated: Array<{ profileId: string; credential: StoredOAuthCredential }> = [];
  for (const [profileId, credential] of Object.entries(params.after.profiles)) {
    if (!isStoredOAuthCredential(credential)) {
      continue;
    }
    const previous = params.before[profileId];
    if (sameStoredOAuthCredential(previous, credential)) {
      continue;
    }
    updated.push({ profileId, credential: { ...credential } });
  }
  return updated;
}

function snapshotStoredOAuthProfiles(
  store: AuthProfileStore,
): Record<string, StoredOAuthCredential> {
  const snapshot: Record<string, StoredOAuthCredential> = {};
  for (const [profileId, credential] of Object.entries(store.profiles)) {
    if (!isStoredOAuthCredential(credential)) {
      continue;
    }
    snapshot[profileId] = { ...credential };
  }
  return snapshot;
}

function persistHealedOAuthProfiles(params: {
  agentDir?: string;
  profileIds: string[];
  mergedStore: AuthProfileStore;
}): void {
  if (!params.agentDir || params.profileIds.length === 0) {
    return;
  }

  const targetStore = loadPersistedAuthProfileStore(params.agentDir);
  let mutated = false;
  for (const profileId of params.profileIds) {
    const mergedCredential = params.mergedStore.profiles[profileId];
    if (!isStoredOAuthCredential(mergedCredential)) {
      continue;
    }
    const existing =
      targetStore.profiles[profileId]?.type === "oauth"
        ? targetStore.profiles[profileId]
        : undefined;
    if (sameStoredOAuthCredential(existing, mergedCredential)) {
      continue;
    }
    targetStore.profiles[profileId] = { ...mergedCredential };
    targetStore.lastGood = { ...targetStore.lastGood, [mergedCredential.provider]: profileId };
    mutated = true;
  }

  if (!mutated) {
    return;
  }

  saveAuthProfileStore(targetStore, params.agentDir);
  log.info("healed stale shared OAuth credentials from main agent", {
    agentDir: params.agentDir,
    profileIds: params.profileIds,
  });
}

export function propagateOAuthProfilesToSiblingAgentStores(params: {
  profiles: Array<{ profileId: string; credential: StoredOAuthCredential }>;
  sourceAgentDir?: string;
  source: string;
}): void {
  if (params.profiles.length === 0) {
    return;
  }

  const agentsRoot = path.join(resolveStateDir(), "agents");
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(agentsRoot, { withFileTypes: true });
  } catch {
    return;
  }

  const sourceAgentDir = path.dirname(resolveAuthStorePath(params.sourceAgentDir));
  const updatedAgentIds: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const targetAgentDir = path.join(agentsRoot, entry.name, "agent");
    if (!fs.existsSync(targetAgentDir)) {
      continue;
    }
    if (path.resolve(targetAgentDir) === path.resolve(sourceAgentDir)) {
      continue;
    }

    const targetStore = loadPersistedAuthProfileStore(targetAgentDir);
    let mutated = false;
    for (const profile of params.profiles) {
      const existing = targetStore.profiles[profile.profileId];
      if (existing && !isStoredOAuthCredential(existing)) {
        continue;
      }
      if (isStoredOAuthCredential(existing) && existing.provider !== profile.credential.provider) {
        continue;
      }
      if (
        isStoredOAuthCredential(existing) &&
        sameStoredOAuthCredential(existing, profile.credential)
      ) {
        continue;
      }
      if (
        isStoredOAuthCredential(existing) &&
        compareStoredOAuthCredentialFreshness(profile.credential, existing) < 0
      ) {
        continue;
      }
      targetStore.profiles[profile.profileId] = { ...profile.credential };
      targetStore.lastGood = {
        ...targetStore.lastGood,
        [profile.credential.provider]: profile.profileId,
      };
      mutated = true;
    }
    if (!mutated) {
      continue;
    }
    saveAuthProfileStore(targetStore, targetAgentDir);
    updatedAgentIds.push(entry.name);
  }

  if (updatedAgentIds.length === 0) {
    return;
  }

  log.info("propagated shared OAuth credentials to sibling agent stores", {
    source: params.source,
    profileIds: params.profiles.map((profile) => profile.profileId),
    targets: updatedAgentIds,
  });
}

function mergeOAuthFileIntoStore(store: AuthProfileStore): boolean {
  const oauthPath = resolveOAuthPath();
  const oauthRaw = loadJsonFile(oauthPath);
  if (!oauthRaw || typeof oauthRaw !== "object") {
    return false;
  }
  const oauthEntries = oauthRaw as Record<string, OAuthCredentials>;
  let mutated = false;
  for (const [provider, creds] of Object.entries(oauthEntries)) {
    if (!creds || typeof creds !== "object") {
      continue;
    }
    const profileId = `${provider}:default`;
    if (store.profiles[profileId]) {
      continue;
    }
    store.profiles[profileId] = {
      type: "oauth",
      provider,
      ...creds,
    };
    mutated = true;
  }
  return mutated;
}

function applyLegacyStore(store: AuthProfileStore, legacy: LegacyAuthStore): void {
  for (const [provider, cred] of Object.entries(legacy)) {
    const profileId = `${provider}:default`;
    if (cred.type === "api_key") {
      store.profiles[profileId] = {
        type: "api_key",
        provider: String(cred.provider ?? provider),
        key: cred.key,
        ...(cred.email ? { email: cred.email } : {}),
      };
      continue;
    }
    if (cred.type === "token") {
      store.profiles[profileId] = {
        type: "token",
        provider: String(cred.provider ?? provider),
        token: cred.token,
        ...(typeof cred.expires === "number" ? { expires: cred.expires } : {}),
        ...(cred.email ? { email: cred.email } : {}),
      };
      continue;
    }
    store.profiles[profileId] = {
      type: "oauth",
      provider: String(cred.provider ?? provider),
      access: cred.access,
      refresh: cred.refresh,
      expires: cred.expires,
      ...(cred.enterpriseUrl ? { enterpriseUrl: cred.enterpriseUrl } : {}),
      ...(cred.projectId ? { projectId: cred.projectId } : {}),
      ...(cred.accountId ? { accountId: cred.accountId } : {}),
      ...(cred.email ? { email: cred.email } : {}),
    };
  }
}

function loadCoercedStore(authPath: string): AuthProfileStore | null {
  const raw = loadJsonFile(authPath);
  return coerceAuthStore(raw);
}

export function loadAuthProfileStore(): AuthProfileStore {
  const authPath = resolveAuthStorePath();
  const asStore = loadCoercedStore(authPath);
  if (asStore) {
    const oauthBeforeSync = snapshotStoredOAuthProfiles(asStore);
    // Sync from external CLI tools on every load.
    const synced = syncExternalCliCredentials(asStore);
    if (synced) {
      saveJsonFile(authPath, asStore);
      propagateOAuthProfilesToSiblingAgentStores({
        profiles: collectUpdatedOAuthProfiles({
          before: oauthBeforeSync,
          after: asStore,
        }),
        source: "external_cli_sync",
      });
    }
    return asStore;
  }
  const legacyRaw = loadJsonFile(resolveLegacyAuthStorePath());
  const legacy = coerceLegacyStore(legacyRaw);
  if (legacy) {
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {},
    };
    applyLegacyStore(store, legacy);
    syncExternalCliCredentials(store);
    return store;
  }

  const store: AuthProfileStore = { version: AUTH_STORE_VERSION, profiles: {} };
  syncExternalCliCredentials(store);
  return store;
}

function loadAuthProfileStoreForAgent(
  agentDir?: string,
  options?: LoadAuthProfileStoreOptions,
): AuthProfileStore {
  const readOnly = options?.readOnly === true;
  const authPath = resolveAuthStorePath(agentDir);
  const asStore = loadCoercedStore(authPath);
  if (asStore) {
    const oauthBeforeSync = snapshotStoredOAuthProfiles(asStore);
    // Runtime secret activation must remain read-only:
    // sync external CLI credentials in-memory, but never persist while readOnly.
    const synced = syncExternalCliCredentials(asStore);
    if (synced && !readOnly) {
      saveJsonFile(authPath, asStore);
      propagateOAuthProfilesToSiblingAgentStores({
        profiles: collectUpdatedOAuthProfiles({
          before: oauthBeforeSync,
          after: asStore,
        }),
        sourceAgentDir: agentDir,
        source: "external_cli_sync",
      });
    }
    return asStore;
  }

  // Fallback: inherit auth-profiles from main agent if subagent has none
  if (agentDir && !readOnly) {
    const mainAuthPath = resolveAuthStorePath(); // without agentDir = main
    const mainRaw = loadJsonFile(mainAuthPath);
    const mainStore = coerceAuthStore(mainRaw);
    if (mainStore && Object.keys(mainStore.profiles).length > 0) {
      // Clone main store to subagent directory for auth inheritance
      saveJsonFile(authPath, mainStore);
      log.info("inherited auth-profiles from main agent", { agentDir });
      return mainStore;
    }
  }

  const legacyRaw = loadJsonFile(resolveLegacyAuthStorePath(agentDir));
  const legacy = coerceLegacyStore(legacyRaw);
  const store: AuthProfileStore = {
    version: AUTH_STORE_VERSION,
    profiles: {},
  };
  if (legacy) {
    applyLegacyStore(store, legacy);
  }

  const mergedOAuth = mergeOAuthFileIntoStore(store);
  const oauthBeforeSync = snapshotStoredOAuthProfiles(store);
  // Keep external CLI credentials visible in runtime even during read-only loads.
  const syncedCli = syncExternalCliCredentials(store);
  const forceReadOnly = process.env.OPENCLAW_AUTH_STORE_READONLY === "1";
  const shouldWrite = !readOnly && !forceReadOnly && (legacy !== null || mergedOAuth || syncedCli);
  if (shouldWrite) {
    saveJsonFile(authPath, store);
    if (syncedCli) {
      propagateOAuthProfilesToSiblingAgentStores({
        profiles: collectUpdatedOAuthProfiles({
          before: oauthBeforeSync,
          after: store,
        }),
        sourceAgentDir: agentDir,
        source: "external_cli_sync",
      });
    }
  }

  // PR #368: legacy auth.json could get re-migrated from other agent dirs,
  // overwriting fresh OAuth creds with stale tokens (fixes #363). Delete only
  // after we've successfully written auth-profiles.json.
  if (shouldWrite && legacy !== null) {
    const legacyPath = resolveLegacyAuthStorePath(agentDir);
    try {
      fs.unlinkSync(legacyPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        log.warn("failed to delete legacy auth.json after migration", {
          err,
          legacyPath,
        });
      }
    }
  }

  return store;
}

export function loadAuthProfileStoreForRuntime(
  agentDir?: string,
  options?: LoadAuthProfileStoreOptions,
): AuthProfileStore {
  const store = loadAuthProfileStoreForAgent(agentDir, options);
  const authPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveAuthStorePath();
  if (!agentDir || authPath === mainAuthPath) {
    return store;
  }

  const mainStore = loadAuthProfileStoreForAgent(undefined, options);
  return mergeAuthProfileStores(mainStore, store);
}

export function loadAuthProfileStoreForSecretsRuntime(agentDir?: string): AuthProfileStore {
  return loadAuthProfileStoreForRuntime(agentDir, { readOnly: true, allowKeychainPrompt: false });
}

export function ensureAuthProfileStore(
  agentDir?: string,
  options?: { allowKeychainPrompt?: boolean },
): AuthProfileStore {
  const runtimeStore = resolveRuntimeAuthProfileStore(agentDir);
  if (runtimeStore) {
    return runtimeStore;
  }

  const store = loadAuthProfileStoreForAgent(agentDir, options);
  const authPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveAuthStorePath();
  if (!agentDir || authPath === mainAuthPath) {
    return store;
  }

  const mainStore = loadAuthProfileStoreForAgent(undefined, options);
  const mergedResult = mergeAuthProfileStoresDetailed(mainStore, store);
  persistHealedOAuthProfiles({
    agentDir,
    profileIds: mergedResult.healedProfileIds,
    mergedStore: mergedResult.store,
  });

  return mergedResult.store;
}

export function saveAuthProfileStore(store: AuthProfileStore, agentDir?: string): void {
  const authPath = resolveAuthStorePath(agentDir);
  const profiles = Object.fromEntries(
    Object.entries(store.profiles).map(([profileId, credential]) => {
      if (credential.type === "api_key" && credential.keyRef && credential.key !== undefined) {
        const sanitized = { ...credential } as Record<string, unknown>;
        delete sanitized.key;
        return [profileId, sanitized];
      }
      if (credential.type === "token" && credential.tokenRef && credential.token !== undefined) {
        const sanitized = { ...credential } as Record<string, unknown>;
        delete sanitized.token;
        return [profileId, sanitized];
      }
      return [profileId, credential];
    }),
  ) as AuthProfileStore["profiles"];
  const payload = {
    version: AUTH_STORE_VERSION,
    profiles,
    order: store.order ?? undefined,
    lastGood: store.lastGood ?? undefined,
    usageStats: store.usageStats ?? undefined,
  } satisfies AuthProfileStore;
  saveJsonFile(authPath, payload);
}
