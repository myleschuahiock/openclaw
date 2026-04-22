#!/usr/bin/env tsx
import { executeBridgeRequest, GmailIntegrationError, parseBridgeArgs } from "../index.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  try {
    const args = parseBridgeArgs(process.argv.slice(2));
    const stdin = args.mode === "send" ? await readStdin() : "";
    const output = await executeBridgeRequest(args, stdin);
    console.log(JSON.stringify(output, null, 2));
    process.exitCode = output.success ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      JSON.stringify(
        {
          success: false,
          mode: "send",
          error_code: error instanceof GmailIntegrationError ? error.code : "CLI_ERROR",
          error_message: message,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}

main();
