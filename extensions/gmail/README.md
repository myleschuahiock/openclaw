# OpenClaw Gmail API Plugin

This plugin adds an optional OpenClaw tool named `send_gmail` for sending mail through the Gmail API with OAuth2. It does not use SMTP or Gmail app passwords.

Default mailbox: `miaibarra.bh@gmail.com`.

## Folder Structure

```text
extensions/gmail/
  index.ts
  openclaw.plugin.json
  package.json
  .env.example
  README.md
  examples/
    openclaw.config.example.json
    send_gmail.example.json
  scripts/
    generate-refresh-token.ts
    smoke-send.ts
  src/
    attachments.ts
    client.ts
    config.ts
    mime.ts
    oauth.ts
    recipients.ts
    send-gmail-tool.ts
    send.ts
    types.ts
```

## Setup

1. Create a Google Cloud project at `https://console.cloud.google.com/`.
2. Go to APIs & Services, then Library, then enable **Gmail API**.
3. Go to APIs & Services, then OAuth consent screen. Configure the app for internal use or testing and add `miaibarra.bh@gmail.com` as a test user if the app is in testing mode.
4. Go to APIs & Services, then Credentials, then Create Credentials, then OAuth client ID.
5. For local development, use a **Web application** client and add this authorized redirect URI:

```text
http://127.0.0.1:33333/oauth2callback
```

6. Copy the example env file:

```bash
cp extensions/gmail/.env.example extensions/gmail/.env
```

7. Fill these values in `extensions/gmail/.env`:

```bash
GMAIL_SENDER=miaibarra.bh@gmail.com
GMAIL_OAUTH_CLIENT_ID=...
GMAIL_OAUTH_CLIENT_SECRET=...
```

8. Generate the first refresh token. Use send-only scope for direct sending:

```bash
pnpm --filter @openclaw/gmail oauth -- --env .env --write-env .env
```

For draft creation or `drafts.send`, request the broader compose scope:

```bash
pnpm --filter @openclaw/gmail oauth -- --env .env --drafts --write-env .env
```

The helper writes `GMAIL_OAUTH_REFRESH_TOKEN` directly to the target `.env` file and does not print it by default. Use `--print-token` only when you explicitly need to copy the token manually.

9. Enable the plugin and allowlist the optional tool:

```json
{
  "plugins": {
    "entries": {
      "gmail": {
        "enabled": true,
        "config": {
          "envFile": "extensions/gmail/.env",
          "sender": "miaibarra.bh@gmail.com",
          "enableDrafts": false
        }
      }
    }
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["send_gmail"] }
      }
    ]
  }
}
```

Set `enableDrafts` to `true` only when the refresh token was generated with `--drafts`.

## Tool API

```json
{
  "to": ["recipient@example.com"],
  "cc": [],
  "bcc": [],
  "subject": "Weekly Report",
  "text": "Attached is the weekly report.",
  "html": "<p>Attached is the weekly report.</p>",
  "attachments": ["/path/to/report.pdf"],
  "reply_to": "miaibarra.bh@gmail.com",
  "save_as_draft": false
}
```

Behavior:

- `save_as_draft: false` calls `users.messages.send`.
- `save_as_draft: true` calls `users.drafts.create`.
- `draft_id: "..."` calls `users.drafts.send` for an existing draft.

The result is structured JSON:

```json
{
  "success": true,
  "mode": "send",
  "message_id": "message-id",
  "thread_id": "thread-id"
}
```

On failure, the tool returns `success: false`, `error_code`, `error_message`, and `retryable`.

## Test With A PDF Attachment

```bash
pnpm --filter @openclaw/gmail smoke -- \
  --to recipient@example.com \
  --subject "OpenClaw Gmail API smoke test" \
  --text "Attached is the Gmail API smoke test PDF." \
  --attachment /path/to/test.pdf
```

To create a draft instead:

```bash
pnpm --filter @openclaw/gmail smoke -- \
  --to recipient@example.com \
  --attachment /path/to/test.pdf \
  --draft
```

## Security Notes

- Store OAuth client secrets and refresh tokens only in `extensions/gmail/.env` or process environment variables.
- Do not commit `.env`, access tokens, refresh tokens, or real client secrets.
- Default scope is `https://www.googleapis.com/auth/gmail.send`.
- Draft support requires `https://www.googleapis.com/auth/gmail.compose`.
- Rotate credentials by revoking the OAuth grant from the Google account security page, creating or rotating the OAuth client secret in Google Cloud, and rerunning the OAuth helper.
- Logs include operation counts, byte sizes, and Gmail IDs only. They do not log tokens, secrets, message bodies, or attachment contents.

## Limits

The plugin checks the encoded MIME message size before calling Gmail. The default limit is `36,700,160` bytes, matching the Gmail API discovery document for message and draft upload methods. Override with `GMAIL_MAX_RAW_BYTES` only if Google changes the published limit.
