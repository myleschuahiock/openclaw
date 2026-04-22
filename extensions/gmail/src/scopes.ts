import {
  GMAIL_COMPOSE_SCOPE,
  GMAIL_MODIFY_SCOPE,
  GMAIL_SEND_SCOPE,
  MAIL_GOOGLE_SCOPE,
  type GmailCapability,
} from "./types.js";

export type GmailScopeSource = "token_response" | "configured_hint" | "unknown";

export function parseGrantedScopes(value: string | string[] | undefined): string[] {
  const rawValues = Array.isArray(value) ? value : [value ?? ""];
  const seen = new Set<string>();
  const granted: string[] = [];
  for (const rawValue of rawValues) {
    for (const token of String(rawValue).split(/\s+/)) {
      const scope = token.trim();
      if (!scope || seen.has(scope)) {
        continue;
      }
      seen.add(scope);
      granted.push(scope);
    }
  }
  return granted;
}

export function resolveGrantedScopes(
  tokenScope: string | undefined,
  hintScopes: string[] = [],
): { scope?: string; grantedScopes: string[]; scopeSource: GmailScopeSource } {
  const fromToken = parseGrantedScopes(tokenScope);
  if (fromToken.length > 0) {
    return {
      scope: tokenScope,
      grantedScopes: fromToken,
      scopeSource: "token_response",
    };
  }

  const fromHint = parseGrantedScopes(hintScopes);
  if (fromHint.length > 0) {
    return {
      scope: fromHint.join(" "),
      grantedScopes: fromHint,
      scopeSource: "configured_hint",
    };
  }

  return { grantedScopes: [], scopeSource: "unknown" };
}

export function capabilitySatisfied(
  capability: GmailCapability,
  grantedScopes: string[],
): boolean | null {
  const scopeSet = new Set(parseGrantedScopes(grantedScopes));
  if (scopeSet.size === 0) {
    return null;
  }
  if (scopeSet.has(MAIL_GOOGLE_SCOPE) || scopeSet.has(GMAIL_MODIFY_SCOPE)) {
    return true;
  }
  if (capability === "send") {
    return scopeSet.has(GMAIL_SEND_SCOPE) || scopeSet.has(GMAIL_COMPOSE_SCOPE);
  }
  return scopeSet.has(GMAIL_COMPOSE_SCOPE);
}

export function formatGrantedScopes(grantedScopes: string[]): string {
  const normalized = parseGrantedScopes(grantedScopes);
  return normalized.length > 0 ? normalized.join(", ") : "unknown";
}
