import { describe, expect, it } from "vitest";
import {
  capabilitySatisfied,
  formatGrantedScopes,
  parseGrantedScopes,
  resolveGrantedScopes,
} from "./scopes.js";
import {
  GMAIL_COMPOSE_SCOPE,
  GMAIL_MODIFY_SCOPE,
  GMAIL_SEND_SCOPE,
  MAIL_GOOGLE_SCOPE,
} from "./types.js";

describe("gmail scope helpers", () => {
  it("parses and de-duplicates granted scopes", () => {
    expect(
      parseGrantedScopes(`${GMAIL_SEND_SCOPE} ${GMAIL_SEND_SCOPE} ${GMAIL_COMPOSE_SCOPE}`),
    ).toEqual([GMAIL_SEND_SCOPE, GMAIL_COMPOSE_SCOPE]);
  });

  it("resolves token scopes first and falls back to configured hints", () => {
    expect(resolveGrantedScopes(GMAIL_SEND_SCOPE, [GMAIL_COMPOSE_SCOPE])).toEqual({
      scope: GMAIL_SEND_SCOPE,
      grantedScopes: [GMAIL_SEND_SCOPE],
      scopeSource: "token_response",
    });
    expect(resolveGrantedScopes(undefined, [GMAIL_COMPOSE_SCOPE])).toEqual({
      scope: GMAIL_COMPOSE_SCOPE,
      grantedScopes: [GMAIL_COMPOSE_SCOPE],
      scopeSource: "configured_hint",
    });
  });

  it("evaluates send and drafts capabilities", () => {
    expect(capabilitySatisfied("send", [GMAIL_SEND_SCOPE])).toBe(true);
    expect(capabilitySatisfied("drafts", [GMAIL_SEND_SCOPE])).toBe(false);
    expect(capabilitySatisfied("drafts", [GMAIL_COMPOSE_SCOPE])).toBe(true);
    expect(capabilitySatisfied("drafts", [GMAIL_MODIFY_SCOPE])).toBe(true);
    expect(capabilitySatisfied("send", [MAIL_GOOGLE_SCOPE])).toBe(true);
    expect(capabilitySatisfied("send", [])).toBeNull();
  });

  it("formats unknown scopes clearly", () => {
    expect(formatGrantedScopes([])).toBe("unknown");
    expect(formatGrantedScopes([GMAIL_SEND_SCOPE])).toBe(GMAIL_SEND_SCOPE);
  });
});
