#!/usr/bin/env tsx
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  buildAuthorizationUrl,
  codeChallengeS256,
  DEFAULT_GMAIL_SENDER,
  exchangeAuthorizationCode,
  GMAIL_COMPOSE_SCOPE,
  GMAIL_SEND_SCOPE,
  generateCodeVerifier,
  parseDotEnv,
} from "../index.js";

type Args = {
  envFile: string;
  port: number;
  drafts: boolean;
  clientId?: string;
  clientSecret?: string;
  loginHint: string;
  writeEnv?: string;
  printToken: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    envFile: "extensions/gmail/.env",
    port: 33333,
    drafts: false,
    loginHint: DEFAULT_GMAIL_SENDER,
    printToken: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i] ?? "";
    if (arg === "--env") {
      args.envFile = next();
    } else if (arg === "--port") {
      args.port = Number(next());
    } else if (arg === "--drafts") {
      args.drafts = true;
    } else if (arg === "--client-id") {
      args.clientId = next();
    } else if (arg === "--client-secret") {
      args.clientSecret = next();
    } else if (arg === "--login-hint") {
      args.loginHint = next();
    } else if (arg === "--write-env") {
      args.writeEnv = next() || args.envFile;
    } else if (arg === "--print-token") {
      args.printToken = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`Generate a Gmail OAuth refresh token.

Usage:
  pnpm --filter @openclaw/gmail oauth -- --env extensions/gmail/.env
  pnpm --filter @openclaw/gmail oauth -- --drafts --write-env extensions/gmail/.env

Options:
  --env PATH             Read client id/secret from PATH (default: extensions/gmail/.env)
  --port PORT            Local OAuth callback port (default: 33333)
  --drafts               Request gmail.compose instead of gmail.send
  --client-id VALUE      Override GMAIL_OAUTH_CLIENT_ID
  --client-secret VALUE  Override GMAIL_OAUTH_CLIENT_SECRET
  --login-hint EMAIL     Google account hint (default: ${DEFAULT_GMAIL_SENDER})
  --write-env PATH       Update PATH with the returned refresh token
  --print-token          Print the refresh token to stdout (off by default)
`);
}

function readEnvFile(filePath: string): Record<string, string | undefined> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  return parseDotEnv(fs.readFileSync(filePath, "utf8"));
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.unref();
}

function writeEnvValue(filePath: string, key: string, value: string): void {
  const absolute = path.resolve(filePath);
  const existing = fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : "";
  const lines = existing.split(/\r?\n/);
  let replaced = false;
  const updated = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!replaced) {
    updated.push(`${key}=${value}`);
  }
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(
    absolute,
    `${updated.filter((line, index) => line || index < updated.length - 1).join("\n")}\n`,
  );
}

async function waitForCode(port: number, expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
        if (url.pathname !== "/oauth2callback") {
          res.writeHead(404).end("Not found");
          return;
        }
        const error = url.searchParams.get("error");
        if (error) {
          throw new Error(error);
        }
        const state = url.searchParams.get("state");
        if (state !== expectedState) {
          throw new Error("OAuth state mismatch");
        }
        const code = url.searchParams.get("code");
        if (!code) {
          throw new Error("Missing OAuth code");
        }
        res.writeHead(200, { "Content-Type": "text/plain", Connection: "close" });
        res.end("Gmail authorization complete. You can close this tab.", () => {
          server.close();
          server.closeAllConnections?.();
          resolve(code);
        });
      } catch (error) {
        res.writeHead(400, { "Content-Type": "text/plain", Connection: "close" });
        res.end(error instanceof Error ? error.message : String(error), () => {
          server.close();
          server.closeAllConnections?.();
          reject(error);
        });
      }
    });
    server.listen(port, "127.0.0.1");
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const fileEnv = readEnvFile(args.envFile);
  const clientId =
    args.clientId ?? process.env.GMAIL_OAUTH_CLIENT_ID ?? fileEnv.GMAIL_OAUTH_CLIENT_ID;
  const clientSecret =
    args.clientSecret ?? process.env.GMAIL_OAUTH_CLIENT_SECRET ?? fileEnv.GMAIL_OAUTH_CLIENT_SECRET;

  if (!clientId) {
    throw new Error("GMAIL_OAUTH_CLIENT_ID is required. Put it in .env or pass --client-id.");
  }

  const redirectUri = `http://127.0.0.1:${args.port}/oauth2callback`;
  const state = crypto.randomUUID();
  const verifier = generateCodeVerifier();
  const scopes = [args.drafts ? GMAIL_COMPOSE_SCOPE : GMAIL_SEND_SCOPE];
  const authUrl = buildAuthorizationUrl({
    clientId,
    redirectUri,
    scopes,
    loginHint: args.loginHint,
    state,
    codeChallenge: codeChallengeS256(verifier),
  });

  console.log(`Opening Google OAuth consent for ${args.loginHint}`);
  console.log(`Redirect URI: ${redirectUri}`);
  console.log(`Requested scope: ${scopes[0]}`);
  openBrowser(authUrl);

  const code = await waitForCode(args.port, state);
  const token = await exchangeAuthorizationCode({
    clientId,
    clientSecret,
    code,
    codeVerifier: verifier,
    redirectUri,
  });

  if (!token.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. Revoke the app grant for this account, then rerun with prompt=consent.",
    );
  }

  console.log("\nRefresh token generated.");
  console.log(`Scope: ${token.scope ?? scopes[0]}`);

  if (args.writeEnv) {
    writeEnvValue(args.writeEnv, "GMAIL_OAUTH_REFRESH_TOKEN", token.refresh_token);
    writeEnvValue(args.writeEnv, "GMAIL_ENABLE_DRAFTS", args.drafts ? "true" : "false");
    console.log(`Updated ${path.resolve(args.writeEnv)}`);
  } else {
    console.log("Refresh token was not written. Rerun with --write-env PATH to store it locally.");
  }

  if (args.printToken) {
    console.log("Set this value in your local .env:");
    console.log(`GMAIL_OAUTH_REFRESH_TOKEN=${token.refresh_token}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
