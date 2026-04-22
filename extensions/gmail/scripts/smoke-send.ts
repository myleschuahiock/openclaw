#!/usr/bin/env tsx
import { sendGmail } from "../src/send.js";

type SmokeArgs = {
  envFile: string;
  to?: string;
  subject: string;
  text: string;
  html?: string;
  attachments: string[];
  draft: boolean;
};

function parseArgs(argv: string[]): SmokeArgs {
  const args: SmokeArgs = {
    envFile: ".env",
    subject: "OpenClaw Gmail API smoke test",
    text: "This is a Gmail API smoke test from OpenClaw.",
    attachments: [],
    draft: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i] ?? "";
    if (arg === "--env") {
      args.envFile = next();
    } else if (arg === "--to") {
      args.to = next();
    } else if (arg === "--subject") {
      args.subject = next();
    } else if (arg === "--text") {
      args.text = next();
    } else if (arg === "--html") {
      args.html = next();
    } else if (arg === "--attachment") {
      args.attachments.push(next());
    } else if (arg === "--draft") {
      args.draft = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`Send a Gmail API smoke test.

Usage:
  pnpm --filter @openclaw/gmail smoke -- --to recipient@example.com --attachment /path/to/report.pdf
  pnpm --filter @openclaw/gmail smoke -- --to recipient@example.com --attachment /path/to/report.pdf --draft

Options:
  --env PATH           Local Gmail .env file (default: .env)
  --to EMAIL           Recipient address
  --attachment PATH    Attachment path. Repeat for multiple files.
  --draft              Create a draft instead of sending immediately.
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.to) {
    throw new Error("--to is required");
  }
  if (args.attachments.length === 0) {
    throw new Error("--attachment is required for the smoke test");
  }

  const result = await sendGmail(
    {
      to: [args.to],
      subject: args.subject,
      text: args.text,
      html: args.html,
      attachments: args.attachments,
      save_as_draft: args.draft,
    },
    { envFile: args.envFile },
  );

  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.success ? 0 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
