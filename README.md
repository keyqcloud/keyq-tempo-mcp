# keyq-tempo-mcp

MCP server that bridges Claude Code sessions to **KeyQ Tempo**.

## What it does

Each Claude Code instance running this MCP server can:

- **Ask the user for input** asynchronously (`ask`, `request_approval`, `notify`) and have the user answer from the Tempo web UI — useful when you're away from the terminal but Claude needs an answer or sign-off.
- **Read Tempo data** (tickets, board cards, tasks, meeting summaries, documents/attachments, customers) so Claude can ground its work in your project history without leaving the session.
- **Create tickets and tasks** for follow-ups Claude discovers during a session.

## Setup

### 1. Enable the bridge for your user (one time, admin)

In Tempo web → **Team Members** → toggle **Claude Code bridge** on for the user.

### 2. Get an enrollment code (per device)

In Tempo web → **Claude Sessions** tab → **Connect a Claude Code session**.

You'll get a 6-digit code that's valid for 5 minutes.

### 3. Enroll this device

```sh
npx keyq-tempo-mcp enroll 123456
```

This stores a long-lived device token at `~/.keyq-tempo/token`. You only need to do this once per machine.

### 4. Add to your Claude Code `mcp.json`

```json
{
  "mcpServers": {
    "keyq-tempo": {
      "command": "npx",
      "args": ["-y", "keyq-tempo-mcp"]
    }
  }
}
```

Restart your Claude Code session. The MCP server will register a new session on each Claude Code start.

## Tools

### Async (block waiting for user response)

- `ask(question, context?)` — sends a question, blocks until the user responds via the Tempo web UI.
- `request_approval(question, context?)` — yes/no approval; renders inline Yes/No buttons in the web UI.
- `notify(message)` — fire-and-forget notification (not blocking).

### Read Tempo data

- `list_customers`
- `list_tickets`, `get_ticket`
- `list_cards`, `get_card`
- `list_tasks`, `get_task`
- `list_meetings`, `get_meeting`
- `list_documents`, `read_document`
- `list_attachments`, `read_attachment`

### Create

- `create_ticket(customer_id, title, description?, type?, priority?)`
- `create_task(title, notes?, customer_id?, due_date?, is_global?)`

## Privacy

Question and response text is encrypted at rest in Tempo's D1 database (AES-GCM). Device tokens are stored as SHA-256 hashes server-side.

You can revoke a device any time via Tempo web → Claude Sessions → Devices.
