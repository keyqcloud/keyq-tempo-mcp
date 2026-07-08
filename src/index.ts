// keyq-tempo-mcp v1.x — sprint-card MCP for Claude Code.
//
// Slimmed down from the bridge-mvp predecessor (preserved on the
// `bridge-mvp` branch). No more session tracking, heartbeats, hooks,
// listening loops, or question/answer relay. Just a focused tool surface
// for the sprint-card workflow:
//   1. Pull a card → work it → comment progress → PR → move card
//   2. If stuck, post a comment + email the operator (their reply lands
//      back on the card via assistant@keyq.io's [Card #N] subject shortcut)

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runEnroll } from './enroll.js';
import { runInstallHooks } from './install-hooks.js';
import * as sprint from './tools/sprint.js';
import * as helpers from './tools/helpers.js';
import * as msgraph from './tools/msgraph.js';

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'enroll') {
    await runEnroll(argv[1] || '');
    return;
  }
  if (argv[0] === 'install-hooks') {
    await runInstallHooks();
    return;
  }
  if (argv[0] === '--help' || argv[0] === '-h') {
    console.error('keyq-tempo-mcp\n');
    console.error('Usage:');
    console.error('  keyq-tempo-mcp enroll <code>   Enroll this device with a 6-digit code from Tempo web');
    console.error('  keyq-tempo-mcp install-hooks   Install the tempo-sprint-mode pre-push hook into the current repo');
    console.error('  keyq-tempo-mcp                 Run as MCP server (over stdio, for Claude Code)');
    return;
  }

  const server = new McpServer({ name: 'keyq-tempo', version: '1.6.0' });

  // --- Sprint card tools (the core 8) ---

  server.tool(
    'tempo_next_card',
    'Pick up the next sprint card to work on. Returns the highest-priority card on the project board that is assigned to the given team_member (by assignee_id) and lives in an in_progress or up_next column. Resume in_progress cards before starting new up_next ones. Returns null when nothing is queued — that means the sprint set is exhausted.',
    {
      project_id: z.number().describe('Tempo project_id (one project = one board). From .claude/sprint-config.json.'),
      assignee_id: z.number().optional().describe('Team_member id to scope to (PREFERRED — stable across renames). A fleet box passes its own member id (its lane). Resolve ids via tempo_list_team_members.'),
      assignee_initials: z.string().optional().describe('Legacy initials filter (mutable — a member can be renamed). Used only if assignee_id is omitted; defaults to CC.'),
    },
    async (args) => ({ content: [{ type: 'text', text: await sprint.nextCard(args) }] }),
  );

  server.tool(
    'tempo_get_card',
    'Read a card in full — title, description, priority, due date, assignee, current column, comments thread (chronological), and attachments. Use this every time before working a card so you have the latest comments (which include any operator clarifications).',
    { id: z.number() },
    async (args) => ({ content: [{ type: 'text', text: await sprint.getCard(args) }] }),
  );

  server.tool(
    'tempo_list_cards',
    'List all cards on a project board, grouped by column. Useful during scrum to scope the sprint set and see what is already assigned where.',
    { project_id: z.number() },
    async (args) => ({ content: [{ type: 'text', text: await sprint.listCards(args) }] }),
  );

  server.tool(
    'tempo_create_card',
    'Create a new card on a project board. During scrum: use this when adding a card that emerged in the discussion (not from Fathom). Either column_id or column_name is required; if neither is given, lands in the first column on the board.',
    {
      project_id: z.number(),
      column_id: z.number().optional(),
      column_name: z.string().optional().describe('Match by exact name, display_group ("up_next" / "in_progress" / etc.), or case-insensitive name.'),
      title: z.string(),
      description: z.string().optional(),
      assignee_id: z.number().optional().describe('team_member id. For sprint cards, use the Claude Code (CC) member id.'),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
      due_date: z.string().optional().describe('ISO YYYY-MM-DD'),
    },
    async (args) => ({ content: [{ type: 'text', text: await sprint.createCard(args) }] }),
  );

  server.tool(
    'tempo_update_card',
    'Update a card\'s fields. Critical during scrum for enriching vague Fathom-generated cards: read the card, ask the operator clarifying questions, then update the description with the captured context. Pass null to clear a nullable field.',
    {
      id: z.number(),
      title: z.string().optional(),
      description: z.string().optional(),
      assignee_id: z.number().nullable().optional(),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
      due_date: z.string().nullable().optional(),
    },
    async (args) => ({ content: [{ type: 'text', text: await sprint.updateCard(args) }] }),
  );

  server.tool(
    'tempo_comment_card',
    'Post a progress comment on a card. Use at meaningful milestones: starting work, hitting a decision point, completing a sub-task, opening a PR. The thread is the audit trail for the operator.',
    {
      id: z.number(),
      content: z.string(),
    },
    async (args) => ({ content: [{ type: 'text', text: await sprint.commentCard(args) }] }),
  );

  server.tool(
    'tempo_move_card',
    'Move a card between columns. Accepts the column name (case-insensitive) or display_group ("up_next" | "in_progress" | "in_review" | "blocked" | "completed"). When you start work, move to in_progress; when you open a PR, move to in_review; the operator manually moves to completed after merging.',
    {
      id: z.number(),
      target_column: z.string().describe('Column name or display_group'),
    },
    async (args) => ({ content: [{ type: 'text', text: await sprint.moveCard(args) }] }),
  );

  server.tool(
    'tempo_move_card_to_board',
    'Move a card to a DIFFERENT board (project) — e.g. when a card was filed on the wrong board. Distinct from tempo_move_card, which only changes columns within the same board. Resolve target_project_id with tempo_list_projects. By default the card keeps its display_group on the destination board (an in_review card lands in the target board\'s review column); pass target_column to place it explicitly.',
    {
      id: z.number(),
      target_project_id: z.number().describe('Destination board / project_id. Resolve from a code/name via tempo_list_projects.'),
      target_column: z.string().optional().describe('Optional destination column on the TARGET board — name or display_group. Omit to preserve the card\'s current display_group.'),
    },
    async (args) => ({ content: [{ type: 'text', text: await sprint.moveCardToBoard(args) }] }),
  );

  server.tool(
    'tempo_email_stuck',
    'Signal that you are stuck on a card and need operator input. Posts a comment on the card with the blocker AND emails the operator (the user this device token belongs to). The operator can reply to the email; their reply lands as a follow-up comment on the same card. STOP working the card after calling this — pick up the next card or end the session.',
    {
      id: z.number(),
      blocker: z.string().describe('What you tried, what is blocking, what input you need from the operator. Be specific.'),
    },
    async (args) => ({ content: [{ type: 'text', text: await sprint.emailStuck(args) }] }),
  );

  // --- Read helpers (projects, team members, Fathom meetings, attachments) ---

  server.tool(
    'tempo_list_projects',
    'List or SEARCH projects (each project is one board) with their id, code, and name. Use this to resolve a project_id from a project code/name (e.g. "TEMPO", "kyte") without asking the operator — every other sprint tool needs a project_id. Pass `query` to filter by a case-insensitive substring of the code or name. Archived projects are hidden unless include_archived is true.',
    {
      include_archived: z.boolean().optional(),
      query: z.string().optional().describe('Case-insensitive substring matched against project code or name (e.g. "kyte"). Omit to list all.'),
    },
    async (args) => ({ content: [{ type: 'text', text: await helpers.listProjects(args) }] }),
  );

  server.tool(
    'tempo_list_team_members',
    'List all team_members with their id, initials, and name. Use this to resolve an assignee_id without asking the operator. The sprint runner is "Claude Code" (initials CC) — assign sprint cards to its id.',
    {},
    async () => ({ content: [{ type: 'text', text: await helpers.listTeamMembers() }] }),
  );

  server.tool(
    'tempo_list_meetings',
    'List recent Fathom meetings. Useful during scrum for finding the source meeting behind a Fathom-generated card, or for reviewing recent action items. Optional customer_id filter, optional limit (default 20).',
    {
      customer_id: z.number().optional(),
      limit: z.number().optional(),
    },
    async (args) => ({ content: [{ type: 'text', text: await helpers.listMeetings(args) }] }),
  );

  server.tool(
    'tempo_get_meeting',
    'Get a Fathom meeting in detail — title, summary, attendees, action items. Use during scrum to recover context for a vague Fathom-generated card.',
    { id: z.number() },
    async (args) => ({ content: [{ type: 'text', text: await helpers.getMeeting(args) }] }),
  );

  server.tool(
    'tempo_read_attachment',
    'Read a text-based attachment\'s contents inline. Returns metadata only for binary files. Use when a card has an attachment that contains relevant context (a spec, a transcript, a CSV, etc.).',
    { id: z.number() },
    async (args) => ({ content: [{ type: 'text', text: await helpers.readAttachment(args) }] }),
  );

  // --- Microsoft 365: operator's own Outlook calendar + mailbox ---
  // These act on the enrolled user's own MS account (via the API's /me/*
  // Graph routes). Requires the operator to have connected Microsoft with
  // mail scopes granted (Settings → Calendar in Tempo web).

  server.tool(
    'tempo_list_calendar_events',
    'List the operator\'s own Outlook calendar events in a time window. Defaults to the next 7 days. Returns each event\'s time, subject, location, Teams/join link, attendees, and id. Use before scheduling to check availability, or to answer "what\'s on my calendar".',
    {
      start: z.string().optional().describe('ISO datetime for window start (default: now).'),
      end: z.string().optional().describe('ISO datetime for window end (default: now + 7 days).'),
      top: z.number().optional().describe('Max events to return (default 25, max 100).'),
    },
    async (args) => ({ content: [{ type: 'text', text: await msgraph.listCalendarEvents(args) }] }),
  );

  server.tool(
    'tempo_create_calendar_event',
    'Create an event on the operator\'s own Outlook calendar. Provide start_iso and either end_iso or duration_minutes (default 30). Attendees are invited by email. Set online_provider="teams" to attach a Teams meeting. Confirm details with the operator before creating.',
    {
      title: z.string(),
      start_iso: z.string().describe('ISO datetime with offset, e.g. 2026-07-10T14:00:00-04:00'),
      end_iso: z.string().optional(),
      duration_minutes: z.number().optional().describe('Used if end_iso is omitted (default 30).'),
      attendees: z.array(z.string()).optional().describe('Required-attendee email addresses.'),
      optional_attendees: z.array(z.string()).optional(),
      body: z.string().optional().describe('Event description / agenda.'),
      online_provider: z.enum(['teams', 'external', 'none']).optional().describe('"teams" attaches a Teams meeting; "external" uses external_link.'),
      external_link: z.string().optional(),
    },
    async (args) => ({ content: [{ type: 'text', text: await msgraph.createCalendarEvent(args) }] }),
  );

  server.tool(
    'tempo_list_emails',
    'List messages from the operator\'s own Outlook mailbox, newest first. Returns sender, subject, preview, read/attachment flags, and a message id (pass to tempo_read_email). Pass `search` to full-text search (relevance-ranked), or `folder` (e.g. "inbox", "sentitems", "drafts").',
    {
      top: z.number().optional().describe('Max messages (default 25, max 100).'),
      search: z.string().optional().describe('Full-text search across the mailbox. Cannot combine with newest-first ordering.'),
      folder: z.string().optional().describe('Well-known folder name: inbox, sentitems, drafts, archive, deleteditems.'),
    },
    async (args) => ({ content: [{ type: 'text', text: await msgraph.listEmails(args) }] }),
  );

  server.tool(
    'tempo_read_email',
    'Read one message in full (headers + body) from the operator\'s mailbox. Get the id from tempo_list_emails.',
    { id: z.string().describe('Message id from tempo_list_emails.') },
    async (args) => ({ content: [{ type: 'text', text: await msgraph.readEmail(args) }] }),
  );

  server.tool(
    'tempo_draft_email',
    'Create a DRAFT email in the operator\'s mailbox WITHOUT sending it. Safe default for composing on their behalf — the operator reviews (and can edit in Outlook) before sending. Returns a draft_id to pass to tempo_send_email. Body is plain text unless html=true.',
    {
      to: z.array(z.string()).describe('Recipient email addresses.'),
      subject: z.string().optional(),
      body: z.string().optional(),
      cc: z.array(z.string()).optional(),
      html: z.boolean().optional().describe('Treat body as HTML (default: plain text).'),
    },
    async (args) => ({ content: [{ type: 'text', text: await msgraph.draftEmail(args) }] }),
  );

  server.tool(
    'tempo_send_email',
    'SEND an email from the operator\'s mailbox — this delivers immediately. Either pass draft_id to send a draft made with tempo_draft_email, or compose inline with to/subject/body. Because this is irreversible, confirm with the operator before calling; prefer tempo_draft_email when unsure.',
    {
      draft_id: z.string().optional().describe('Send an existing draft (from tempo_draft_email). Omit to compose inline.'),
      to: z.array(z.string()).optional().describe('Required when composing inline (no draft_id).'),
      subject: z.string().optional(),
      body: z.string().optional(),
      cc: z.array(z.string()).optional(),
      html: z.boolean().optional(),
    },
    async (args) => ({ content: [{ type: 'text', text: await msgraph.sendEmail(args) }] }),
  );

  // --- Connect transport ---

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[keyq-tempo-mcp] Connected (sprint-mode v1.6.0)');
}

main().catch((err) => {
  console.error('[keyq-tempo-mcp] Fatal:', err);
  process.exit(1);
});
