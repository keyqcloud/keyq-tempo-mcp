# CLAUDE.md — KeyQ Tempo MCP

Guidance for Claude Code and developers working in this repo. This is the **MCP (Model Context Protocol) server** that exposes KeyQ Tempo sprint cards, meetings, and team data to Claude Code — the bridge that lets an agent run the sprint workflow (pick a card → work it → comment → move it → email when stuck).

GitHub: `keyqcloud/keyq-tempo-mcp` (**public**) · default branch: `main` · current version **1.1.1**

This is **sprint-mode v1**: a minimal, stateless tool surface over the Tempo API. The earlier bidirectional bridge MVP (session tracking, hooks, listening loops) lives on the `bridge-mvp` branch for archaeology and is **not** what this is.

---

## Where this fits
- Pure client of **keyq-tempo-api** (`https://tempo-api.keyq.io`, overridable via `KEYQ_TEMPO_API_URL`).
- Auth is a long-lived **device token** (`tcc_`-prefixed, SHA-256 hashed server-side), sent as `Authorization: Bearer <token>`. Obtained via a 6-digit enrollment code from the Tempo web UI; stored at `~/.keyq-tempo/token` (mode 0600).
- Works in tandem with the **sprint-mode** Claude Code skill, which reads `.claude/sprint-config.json` in the target repo.

## Stack
- Node 20+, TypeScript 5.7 (strict), **ESM**. Build via **tsup** → single `dist/index.js` with a `#!/usr/bin/env node` shebang.
- Deps: `@modelcontextprotocol/sdk` (1.29) and `zod` (3.25) only. Transport: **stdio**.
- Published to npm as `keyq-tempo-mcp`; users run `npx keyq-tempo-mcp`.

## Commands
```bash
npm run build   # tsup → dist/ (also runs as `prepare` on install/publish)
npm run dev     # tsx src/index.ts
npm run start    # node dist/index.js
```
No tests, **no CI** (`.github/` absent). Release = bump version in `package.json` + `src/index.ts` (line ~38), tag `vX.Y.Z`, `npm publish`. `files` ships `dist`, `templates`, `README.md`.

## Setup (user-facing)
1. Admin enables the Claude Code bridge for the team member in Tempo web.
2. `npx keyq-tempo-mcp enroll <6-digit-code>` (code from web → Claude Sessions tab) → writes `~/.keyq-tempo/token`.
3. Add to Claude Code `mcp.json`:
   ```json
   { "mcpServers": { "keyq-tempo": { "command": "npx", "args": ["-y", "keyq-tempo-mcp"] } } }
   ```
4. Optional per-repo: `npx keyq-tempo-mcp install-hooks` (pre-push guard) + `.claude/sprint-config.json`.

## Layout
```
src/index.ts          # CLI arg parsing (enroll / install-hooks / run); registers tools; stdio transport
src/api.ts            # fetch wrapper: auth header, timeout, ApiError, fetchRaw for binary
src/config.ts         # token + API-URL persistence (~/.keyq-tempo/); env > disk > default
src/enroll.ts         # 6-digit enrollment → /mcp/enroll → save device token
src/install-hooks.ts  # copies templates/pre-push into .git/hooks
src/tools/sprint.ts   # 8 sprint workflow tools + resolveColumnId()
src/tools/helpers.ts  # team-members, meetings, attachment-read tools
templates/pre-push    # git hook script
```
Architecture is flat and functional: each tool is `server.tool(name, desc, zodSchema, handler)`, handlers call `api.get/post/put/delete`, return `{ content: [{ type: 'text', text }] }` (pretty JSON, or markdown for meetings).

## Tools (12)
**Sprint workflow** — `tempo_next_card` (next CC-assigned card by priority), `tempo_get_card`, `tempo_list_cards`, `tempo_create_card`, `tempo_update_card`, `tempo_comment_card`, `tempo_move_card` (accepts column name or display_group), `tempo_email_stuck` (comments + emails operator; their reply returns via `[Card #N]` subject).
**Read helpers** — `tempo_list_team_members` (resolve assignee_id; sprint runner is "Claude Code"/CC), `tempo_list_meetings` + `tempo_get_meeting` (Fathom summaries/action items for scrum), `tempo_read_attachment` (text inline, max 64 KB, binary → metadata only).

`resolveColumnId()` matches columns by exact name → `display_group` (`up_next`/`in_progress`/`in_review`/`blocked`/`completed`/`other`) → case-insensitive; unknown names throw a 400 listing valid columns.

## Pre-push hook
`templates/pre-push` reads `target_branch` from `.claude/sprint-config.json` and **blocks pushes from `tempo/*` branches directly to `target_branch`** (forces PR review). Humans pushing from non-`tempo/*` branches and force-pushes within `tempo/*` are allowed. Bypass with `SKIP_TEMPO_HOOK=1 git push`. Idempotent; no-ops if no sprint config.

## Config & gotchas
- Token at `~/.keyq-tempo/token` (0600); API URL resolves env `KEYQ_TEMPO_API_URL` → `~/.keyq-tempo/api-url` → `https://tempo-api.keyq.io`.
- Not enrolled → `ApiError(401)` on the first tool call.
- Windows: `chmodSync` is wrapped in try/catch (best-effort).
- Keep tool descriptions docstring-quality — Claude relies on them to choose tools.
- Public repo — no secrets, internal URLs, or customer data in code or commits.
- Commit/push only when asked.
