# CLAUDE.md — KeyQ Tempo MCP

Guidance for Claude Code and developers working in this repo. This is the **MCP (Model Context Protocol) server** that exposes KeyQ Tempo sprint cards, meetings, and team data to Claude Code — the bridge that lets an agent run the sprint workflow (pick a card → work it → comment → move it → email when stuck).

GitHub: `keyqcloud/keyq-tempo-mcp` (**public**) · npm: `@keyqinc/tempo-mcp` · default branch: `main` · current version **1.12.0**

This is **sprint-mode v1**: a minimal, stateless tool surface over the Tempo API. The earlier bidirectional bridge MVP (session tracking, hooks, listening loops) lives on the `bridge-mvp` branch for archaeology and is **not** what this is.

---

## Where this fits
- Pure client of **keyq-tempo-api** (`https://tempo-api.keyq.io`, overridable via `KEYQ_TEMPO_API_URL`).
- Auth is a long-lived **device token** (`tcc_`-prefixed, SHA-256 hashed server-side), sent as `Authorization: Bearer <token>`. Obtained via a 6-digit enrollment code from the Tempo web UI; stored at `~/.keyq-tempo/token` (mode 0600).
- Works in tandem with the **sprint-mode** Claude Code skill, which reads `.claude/sprint-config.json` in the target repo.

## Stack
- Node 20+, TypeScript 5.7 (strict), **ESM**. Build via **tsup** → single `dist/index.js` with a `#!/usr/bin/env node` shebang.
- Deps: `@modelcontextprotocol/sdk` (1.29) and `zod` (3.25) only. Transport: **stdio**.
- Published to npm as **`@keyqinc/tempo-mcp`**; users run `npx @keyqinc/tempo-mcp`. The unscoped
  `keyq-tempo-mcp` is deprecated and frozen at 1.11.0 — npm has no user-account → organization
  transfer for unscoped packages, so republishing under the org's scope was the only route.

## Commands
```bash
npm run build   # tsup → dist/ (also runs as `prepare` on install/publish)
npm run dev     # tsx src/index.ts
npm run start    # node dist/index.js
```
No tests. **CI publishes on version change** (`.github/workflows/publish.yml`), authenticated by
npm Trusted Publishing (OIDC) — there is no `NPM_TOKEN` to store or rotate. Release = bump
`version` in `package.json` **and** the `VERSION` constant at the top of `src/index.ts`, then
merge to `main`; the workflow compares against the registry and publishes if they differ. No tag
ceremony. `files` ships `dist`, `templates`, `README.md`.

Those two version literals used to be three, and all three disagreed (package 1.11.0 / MCP
handshake 1.9.0 / connect log 1.8.0). Nothing failed on that, which is why it drifted — a wrong
version is invisible until someone debugging a box believes the one it prints.

## Setup (user-facing)
1. Admin enables the Claude Code bridge for the team member in Tempo web.
2. `npx @keyqinc/tempo-mcp enroll <6-digit-code>` (code from web → Claude Sessions tab) → writes `~/.keyq-tempo/token`.
3. Add to Claude Code `mcp.json`:
   ```json
   { "mcpServers": { "keyq-tempo": { "command": "npx", "args": ["-y", "@keyqinc/tempo-mcp"] } } }
   ```
4. Optional per-repo: `npx @keyqinc/tempo-mcp install-hooks` (pre-push guard) + `.claude/sprint-config.json`.

## Layout
```
src/index.ts          # CLI arg parsing (enroll / install-hooks / run); registers tools; stdio transport
src/api.ts            # fetch wrapper: auth header, timeout, ApiError, fetchRaw for binary
src/config.ts         # token + API-URL persistence (~/.keyq-tempo/); env > disk > default
src/enroll.ts         # 6-digit enrollment → /mcp/enroll → save PERSONAL device token
src/enroll-fleet.ts   # same code flow, but the box authenticates as ITSELF (a fleet lane),
                      #   then writes its manifest from what the API says it is granted (#743)
src/install-hooks.ts  # copies templates/pre-push into .git/hooks
src/tools/sprint.ts   # sprint workflow tools + resolveColumnId()
src/tools/helpers.ts  # team-members, meetings, attachment-read tools
src/tools/entities.ts # customers, projects, project docs
src/tools/worklists.ts# tickets, tasks, leads
src/tools/msgraph.ts  # the operator's own Outlook mail + calendar via the API Graph routes
src/tools/designs.ts  # client-facing design mockups + share links
templates/pre-push    # git hook script
.github/workflows/publish.yml  # npm publish on version change (Trusted Publishing, no token)
```
Architecture is flat and functional: each tool is `server.tool(name, desc, zodSchema, handler)`, handlers call `api.get/post/put/delete`, return `{ content: [{ type: 'text', text }] }` (pretty JSON, or markdown for meetings).

## Tools (47)

Counted from the `server.tool(...)` registrations in `src/index.ts` — this said **12** for a
long time while the real surface grew to 47, so regenerate it rather than editing by hand:
`grep -A1 "server.tool(" src/index.ts | grep -oE "tempo_[a-z_]+" | sort -u`

**Sprint workflow** — `tempo_next_card` (next CC-assigned card by priority), `tempo_get_card`,
`tempo_list_cards`, `tempo_create_card`, `tempo_update_card`, `tempo_comment_card`,
`tempo_move_card` (column name or `display_group`), `tempo_move_card_to_board`,
`tempo_email_stuck` (comments + emails the operator; their reply returns via the `[Card #N]`
subject shortcut).

**Tickets & tasks** — `tempo_list_tickets`, `tempo_get_ticket`, `tempo_create_ticket`,
`tempo_update_ticket`, `tempo_comment_ticket`, `tempo_list_tasks`, `tempo_create_task`,
`tempo_update_task`, `tempo_delete_task`.

**Entities** — `tempo_list_customers`, `tempo_create_customer`, `tempo_update_customer`,
`tempo_delete_customer`, `tempo_list_projects`, `tempo_create_project`, `tempo_update_project`,
`tempo_delete_project`, `tempo_list_team_members` (resolve `assignee_id`; the sprint runner is
"Claude Code"/CC), `tempo_get_project_doc`, `tempo_update_project_doc`.

**Leads** — `tempo_list_leads`, `tempo_get_lead`, `tempo_update_lead`, `tempo_archive_lead`.

**Designs** — `tempo_list_designs`, `tempo_get_design`, `tempo_create_design`,
`tempo_author_design_screens`, `tempo_create_design_share`.

**Microsoft 365** (the operator's own mailbox/calendar, via the API's delegated Graph routes;
requires the operator to have connected their Microsoft account) — `tempo_list_calendar_events`,
`tempo_create_calendar_event`, `tempo_list_emails`, `tempo_read_email`, `tempo_draft_email`,
`tempo_send_email`.

**Read helpers** — `tempo_list_meetings` + `tempo_get_meeting` (summaries/action items for
scrum), `tempo_read_attachment` (text inline, max 64 KB; binary → metadata only).

`resolveColumnId()` matches columns by exact name → `display_group` (`up_next`/`in_progress`/`in_review`/`blocked`/`completed`/`other`) → case-insensitive; unknown names throw a 400 listing valid columns.

## Pre-push hook
`templates/pre-push` reads `target_branch` from `.claude/sprint-config.json` and **blocks pushes from `tempo/*` branches directly to `target_branch`** (forces PR review). Humans pushing from non-`tempo/*` branches and force-pushes within `tempo/*` are allowed. Bypass with `SKIP_TEMPO_HOOK=1 git push`. Idempotent; no-ops if no sprint config.

## Config & gotchas
- Token at `~/.keyq-tempo/token` (0600); API URL resolves env `KEYQ_TEMPO_API_URL` → `~/.keyq-tempo/api-url` → `https://tempo-api.keyq.io`.
- Not enrolled → `ApiError(401)` on the first tool call.
- Windows: `chmodSync` is wrapped in try/catch (best-effort).
- Keep tool descriptions docstring-quality — Claude relies on them to choose tools.
- Public repo — no secrets, internal URLs, or customer data in code or commits. Note the npm
  tarball ships `dist/index.js` **unminified with comments**, so publishing is the disclosure,
  not the repo's visibility: making the repo private would hide nothing and would break the
  `github:keyqcloud/keyq-tempo-mcp` installs the Tempo web UI hands out.
- The API is the security boundary, not this client. Endpoint names and field shapes here are
  recon value only — but do not describe gaps in unfinished server-side plumbing in operator
  output, which is a map to the soft spot rather than a fact about this client.
- Commit/push only when asked.
