import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAuthorizationStart,
  parseArgs as parseOAuthHelperArgs,
  waitForCode,
} from "../scripts/generate-refresh-token.ts";
import { GMAIL_SEND_SCOPE } from "./types.js";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("gmail oauth helper", () => {
  it("parses manual browser mode", () => {
    expect(parseOAuthHelperArgs(["--env", ".env", "--no-open"])).toMatchObject({
      envFile: ".env",
      noOpen: true,
    });
  });

  it("builds the authorization URL for the requested login hint", () => {
    const start = buildAuthorizationStart(
      {
        envFile: "extensions/gmail/.env",
        port: 33333,
        drafts: false,
        loginHint: "miaibarra.bh@gmail.com",
        printToken: false,
        noOpen: true,
      },
      "client-id",
    );

    expect(start.redirectUri).toBe("http://127.0.0.1:33333/oauth2callback");
    expect(start.scopes).toEqual([GMAIL_SEND_SCOPE]);
    expect(start.authUrl).toContain("client_id=client-id");
    expect(start.authUrl).toContain("login_hint=miaibarra.bh%40gmail.com");
  });

  it("fails clearly when the callback port is already in use", async () => {
    const server = http.createServer();
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", (error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP server address");
    }

    await expect(waitForCode(address.port, "state")).rejects.toThrow(
      `Failed to listen on http://127.0.0.1:${address.port}/oauth2callback`,
    );
  });
});
