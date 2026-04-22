---
name: gmail
description: Send email through the OpenClaw Gmail plugin using the Gmail API with OAuth2. Use when a user asks OpenClaw to send Gmail messages, create Gmail drafts, or deliver report attachments from the configured Gmail mailbox.
---

# Gmail Sending

Use the `send_gmail` tool when the Gmail plugin is enabled and the user has authorized the configured mailbox.

Default mailbox for this workspace: `miaibarra.bh@gmail.com`.

## Tool Shape

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

## Rules

- Use `save_as_draft: true` when the user asks to review before sending.
- Use immediate send only when the user clearly requested delivery.
- Do not expose OAuth client secrets, refresh tokens, access tokens, or full local `.env` contents.
- Keep attachment paths explicit. Do not invent files.
- If Gmail returns a failure, report the structured error fields from the tool.
