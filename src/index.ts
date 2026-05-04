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
import * as sprint from './tools/sprint.js';
import * as helpers from './tools/helpers.js';

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'enroll') {
    await runEnroll(argv[1] || '');
    return;
  }
  if (argv[0] === '--help' || argv[0] === '-h') {
    console.error('keyq-tempo-mcp\n');
    console.error('Usage:');
    console.error('  keyq-tempo-mcp enroll <code>   Enroll this device with a 6-digit code from Tempo web');
    console.error('  keyq-tempo-mcp                 Run as MCP server (over stdio, for Claude Code)');
    return;
  }

  const server = new McpServer({ name: 'keyq-tempo', version: '1.0.0' });

  // --- Sprint card tools (the core 8) ---

  server.tool(
    'tempo_next_card',
    'Pick up the next sprint card to work on. Returns the highest-priority card on the project board that is assigned to "Claude Code" (CC) and lives in an in_progress or up_next column. Resume in_progress cards before starting new up_next ones. Returns null when nothing is queued — that means the sprint set is exhausted.',
    {
      project_id: z.number().describe('Tempo project_id (one project = one board). From .claude/sprint-config.json.'),
      assignee_initials: z.string().optional().describe('Override assignee filter (defaults to CC = Claude Code). Rare.'),
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
    'tempo_email_stuck',
    'Signal that you are stuck on a card and need operator input. Posts a comment on the card with the blocker AND emails the operator (the user this device token belongs to). The operator can reply to the email; their reply lands as a follow-up comment on the same card. STOP working the card after calling this — pick up the next card or end the session.',
    {
      id: z.number(),
      blocker: z.string().describe('What you tried, what is blocking, what input you need from the operator. Be specific.'),
    },
    async (args) => ({ content: [{ type: 'text', text: await sprint.emailStuck(args) }] }),
  );

  // --- Read helpers (Fathom meetings + attachment reading) ---

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

  // --- Connect transport ---

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[keyq-tempo-mcp] Connected (sprint-mode v1.0.0)');
}

main().catch((err) => {
  console.error('[keyq-tempo-mcp] Fatal:', err);
  process.exit(1);
});
