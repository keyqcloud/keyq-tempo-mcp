# keyq-tempo-mcp

MCP server for the **KeyQ Tempo** sprint-card workflow with Claude Code.

This is **sprint-mode v1**. The previous bidirectional bridge (`ask`,
`request_approval`, `notify`, listening loop, Stop/PreToolUse hooks) is
preserved on the [`bridge-mvp`](../../tree/bridge-mvp) branch for archaeology.

## What it does

Each Claude Code instance running this MCP server can:

- **Pull the next sprint card** assigned to the "Claude Code" (CC) team_member on a configured Tempo board, and work it.
- **Read card detail** including comments thread (operator clarifications) and attachments.
- **Create / update / comment on / move cards** — the workflow Claude needs to drive a sprint forward.
- **Email the operator** when stuck. The blocker is posted as a comment on the card AND emailed to the user. Operator's reply lands back on the card via the AI router's `[Card #N]` subject shortcut.

For scrum context: read recent **Fathom meetings** and **attachments** on cards to recover decisions/requirements.

## Setup

### 1. Enable the bridge for your user (one-time, admin)

In Tempo web → **Team Members** → toggle **Claude Code bridge** on for the user.

### 2. Enroll this device (one-time, per machine)

In Tempo web → **Claude Sessions** tab → **Connect a Claude Code session**. You'll get a 6-digit code valid for 5 minutes.

```sh
npx keyq-tempo-mcp enroll 123456
```

This stores a long-lived device token at `~/.keyq-tempo/token` (mode 0600).

### 3. Add to your Claude Code `mcp.json`

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

### 4. Configure each repo for sprint mode

Add `.claude/sprint-config.json` to each repo Claude will work in:

```json
{
  "project_code": "MPG",
  "tempo_project_id": 12,
  "branching_strategy": "card_branches",
  "target_branch": "main"
}
```

For team-branch projects (e.g. MPG with a long-running `dev` branch):

```json
{
  "project_code": "MPG",
  "tempo_project_id": 12,
  "branching_strategy": "team_branch",
  "target_branch": "dev"
}
```

The sprint-mode skill (`~/.claude/skills/sprint-mode/`) reads this config to know which Tempo board to pull cards from and which branch to target with PRs.

## Tools exposed

### Sprint workflow (8 tools)

- `tempo_next_card(project_id)` — pick up the next card
- `tempo_get_card(id)` — full detail with comments + attachments
- `tempo_list_cards(project_id)` — full board (columns + cards)
- `tempo_create_card(project_id, ...)` — new card
- `tempo_update_card(id, ...)` — edit fields (vital for scrum-time enrichment)
- `tempo_comment_card(id, content)` — progress comment
- `tempo_move_card(id, target_column)` — column transition
- `tempo_email_stuck(id, blocker)` — comment + email operator

### Read helpers (3 tools)

- `tempo_list_meetings(...)` — Fathom meeting summaries for scrum context
- `tempo_get_meeting(id)` — single meeting detail
- `tempo_read_attachment(id)` — text attachment contents inline

## Authentication

Device token (`tcc_*` prefix) loaded from `~/.keyq-tempo/token`. Sent as `Authorization: Bearer <token>` on every API call. Tokens are SHA-256 hashed in Tempo's database; the raw token only ever lives on disk + in-memory in this process.

## Versioning

- **v1.0.0** — sprint-card workflow (this version)
- **v0.x** — bidirectional bridge MVP, preserved on the `bridge-mvp` branch

## License

MIT
