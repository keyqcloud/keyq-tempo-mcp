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
import { runEnrollFleet } from './enroll-fleet.js';
import { runInstallHooks } from './install-hooks.js';
import * as sprint from './tools/sprint.js';
import * as helpers from './tools/helpers.js';
import * as msgraph from './tools/msgraph.js';
import * as worklists from './tools/worklists.js';
import * as entities from './tools/entities.js';
import * as designs from './tools/designs.js';

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'enroll-fleet') {
    await runEnrollFleet(argv[1] || '');
    return;
  }
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
    console.error('  keyq-tempo-mcp enroll <code>        Enroll this device with a 6-digit code from Tempo web');
  console.error('  keyq-tempo-mcp enroll-fleet <code>  Enroll this machine as a fleet box (code from the Fleet page)');
    console.error('  keyq-tempo-mcp install-hooks   Install the tempo-sprint-mode pre-push hook into the current repo');
    console.error('  keyq-tempo-mcp                 Run as MCP server (over stdio, for Claude Code)');
    return;
  }

  const server = new McpServer({ name: 'keyq-tempo', version: '1.9.0' });

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
    'Create a new card on a project board. During scrum: use this when adding a card that emerged in the discussion (not from a meeting). Either column_id or column_name is required; if neither is given, lands in the first column on the board.',
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
    'Update a card\'s fields. Critical during scrum for enriching vague meeting-generated cards: read the card, ask the operator clarifying questions, then update the description with the captured context. Pass null to clear a nullable field.',
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

  // --- Read helpers (projects, team members, recorded meetings, attachments) ---

  server.tool(
    'tempo_list_projects',
    'List or SEARCH projects (each project is one board) with their id, code, name, and owning customer. Use this to resolve a project_id from a project code/name (e.g. "TEMPO", "kyte") without asking the operator — every other sprint tool needs a project_id. Pass `query` to filter by a case-insensitive substring of the code or name, or `customer_id` to list every board belonging to one customer (a customer can own several boards; resolve the id via tempo_list_customers). Archived projects are hidden unless include_archived is true.',
    {
      include_archived: z.boolean().optional(),
      query: z.string().optional().describe('Case-insensitive substring matched against project code or name (e.g. "kyte"). Omit to list all.'),
      customer_id: z.number().optional().describe('List only boards owned by this customer. Resolve the id via tempo_list_customers. A customer often owns multiple boards.'),
    },
    async (args) => ({ content: [{ type: 'text', text: await helpers.listProjects(args) }] }),
  );

  server.tool(
    'tempo_get_project_doc',
    'Read a project board\'s live scope document — its purpose, current priorities, in/out-of-scope boundaries, card-authoring conventions, and decisions log. READ THIS before planning or working on a board so you share the operator\'s context. Returns {content, version}; a null content / version 0 means no doc exists yet.',
    { project_id: z.number() },
    async (args) => ({ content: [{ type: 'text', text: await sprint.getProjectDoc(args) }] }),
  );

  server.tool(
    'tempo_update_project_doc',
    'Create or update a project board\'s scope document (see tempo_get_project_doc). Optimistic concurrency: pass base_version = the version you last read (0 to create). Success returns the new {version}. On a version conflict the result text explains how to rebase and retry — follow it exactly; never force an old base_version.',
    {
      project_id: z.number(),
      content: z.string(),
      base_version: z.number().describe('The version you last read via tempo_get_project_doc; 0 to create a new doc.'),
    },
    async (args) => ({ content: [{ type: 'text', text: await sprint.updateProjectDoc(args) }] }),
  );

  server.tool(
    'tempo_list_team_members',
    'List all team_members with their id, initials, and name. Use this to resolve an assignee_id without asking the operator. The sprint runner is "Claude Code" (initials CC) — assign sprint cards to its id.',
    {},
    async () => ({ content: [{ type: 'text', text: await helpers.listTeamMembers() }] }),
  );

  server.tool(
    'tempo_list_meetings',
    'List recent recorded meetings — both bot-recorded calls and in-person recordings. Useful during scrum for finding the source meeting behind a card, or for reviewing recent action items. Optional customer_id filter, optional limit (default 20).',
    {
      customer_id: z.number().optional(),
      limit: z.number().optional(),
    },
    async (args) => ({ content: [{ type: 'text', text: await helpers.listMeetings(args) }] }),
  );

  server.tool(
    'tempo_get_meeting',
    'Get a recorded meeting in detail — title, summary, attendees, action items. Use during scrum to recover context for a vague card.',
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

  // --- Tasks (freeform to-dos, NOT sprint cards) ---

  server.tool(
    'tempo_list_tasks',
    'List the operator\'s freeform tasks (the Tasks list — distinct from sprint cards on a board). Completed tasks are hidden unless include_completed is set. Optionally filter by status or assignee_id. Returns id, title, status, due date, customer, and assignee for each.',
    {
      status: z.enum(['pending', 'in_progress', 'blocked', 'completed']).optional(),
      assignee_id: z.number().optional().describe('team_member id (resolve via tempo_list_team_members).'),
      include_completed: z.boolean().optional().describe('Include completed tasks (default false).'),
    },
    async (args) => ({ content: [{ type: 'text', text: await worklists.listTasks(args) }] }),
  );

  server.tool(
    'tempo_create_task',
    'Create a freeform task. Only title is required. Assign to a team member (assigned_to) or mark is_global so anyone can claim it. status defaults to "pending".',
    {
      title: z.string(),
      notes: z.string().optional(),
      status: z.enum(['pending', 'in_progress', 'blocked', 'completed']).optional(),
      assigned_to: z.number().optional().describe('team_member id.'),
      customer_id: z.number().optional(),
      is_global: z.boolean().optional().describe('Unassigned pool task anyone can claim.'),
      due_date: z.string().optional().describe('ISO YYYY-MM-DD'),
    },
    async (args) => ({ content: [{ type: 'text', text: await worklists.createTask(args) }] }),
  );

  server.tool(
    'tempo_update_task',
    'Update a task. Set status to "completed" to mark it done (stamps completed_at). Pass only the fields you want to change; assigned_to/customer_id/due_date accept null to clear.',
    {
      id: z.number(),
      title: z.string().optional(),
      notes: z.string().optional(),
      status: z.enum(['pending', 'in_progress', 'blocked', 'completed']).optional(),
      assigned_to: z.number().nullable().optional(),
      customer_id: z.number().nullable().optional(),
      is_global: z.boolean().optional(),
      due_date: z.string().nullable().optional(),
    },
    async (args) => ({ content: [{ type: 'text', text: await worklists.updateTask(args) }] }),
  );

  server.tool(
    'tempo_delete_task',
    'Permanently delete a task (and its attachments). Irreversible — prefer marking it completed via tempo_update_task unless the operator wants it gone.',
    { id: z.number() },
    async (args) => ({ content: [{ type: 'text', text: await worklists.deleteTask(args) }] }),
  );

  // --- Support tickets ---

  server.tool(
    'tempo_list_tickets',
    'List support tickets, newest first. Optionally filter by status (open | in_progress | closed) or customer_id. Returns id, title, status, priority, type, customer, assignee, and tags.',
    {
      status: z.string().optional().describe('open | in_progress | closed'),
      customer_id: z.number().optional(),
    },
    async (args) => ({ content: [{ type: 'text', text: await worklists.listTickets(args) }] }),
  );

  server.tool(
    'tempo_get_ticket',
    'Read one support ticket in full — description, reporter, assignee, tags, and the full comment thread.',
    { id: z.number() },
    async (args) => ({ content: [{ type: 'text', text: await worklists.getTicket(args) }] }),
  );

  server.tool(
    'tempo_create_ticket',
    'Open a support ticket for a customer. customer_id and title are required. type defaults to "support" (bug | support | feature | other); priority defaults to "medium". Assigning to a team member emails them.',
    {
      customer_id: z.number().describe('Required. The customer this ticket is for.'),
      title: z.string(),
      description: z.string().optional(),
      type: z.enum(['bug', 'support', 'feature', 'other']).optional(),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
      assigned_to: z.number().optional().describe('team_member id.'),
    },
    async (args) => ({ content: [{ type: 'text', text: await worklists.createTicket(args) }] }),
  );

  server.tool(
    'tempo_update_ticket',
    'Update a support ticket. Changing status emails the reporter. Pass only the fields to change; assigned_to accepts null to unassign.',
    {
      id: z.number(),
      title: z.string().optional(),
      description: z.string().optional(),
      type: z.enum(['bug', 'support', 'feature', 'other']).optional(),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
      status: z.string().optional().describe('open | in_progress | closed'),
      assigned_to: z.number().nullable().optional(),
    },
    async (args) => ({ content: [{ type: 'text', text: await worklists.updateTicket(args) }] }),
  );

  server.tool(
    'tempo_comment_ticket',
    'Add a comment to a support ticket. Notifies the other party (reporter or assignee) by email.',
    { id: z.number(), content: z.string() },
    async (args) => ({ content: [{ type: 'text', text: await worklists.commentTicket(args) }] }),
  );

  // --- Leads (sales intake) ---

  server.tool(
    'tempo_list_leads',
    'List sales leads, newest first. Junk/sales solicitations and archived leads are hidden by default. Pass status to view a specific bucket (incl. junk/sales), or archived=true to view the archive. Returns id, name, contact, status, company, and source.',
    {
      status: z.enum(['new', 'contacted', 'qualified', 'won', 'lost', 'junk', 'sales']).optional(),
      archived: z.boolean().optional().describe('Show archived leads instead of active ones.'),
    },
    async (args) => ({ content: [{ type: 'text', text: await worklists.listLeads(args) }] }),
  );

  server.tool(
    'tempo_get_lead',
    'Read one lead in full — contact details, the inbound message, and any existing customer matches (by email/domain).',
    { id: z.number() },
    async (args) => ({ content: [{ type: 'text', text: await worklists.getLead(args) }] }),
  );

  server.tool(
    'tempo_update_lead',
    'Set a lead\'s status. Use "junk" for spam and "sales" for sales solicitations (both hidden from the default list); the pipeline statuses are new → contacted → qualified → won/lost.',
    {
      id: z.number(),
      status: z.enum(['new', 'contacted', 'qualified', 'won', 'lost', 'junk', 'sales']),
    },
    async (args) => ({ content: [{ type: 'text', text: await worklists.updateLead(args) }] }),
  );

  server.tool(
    'tempo_archive_lead',
    'Archive a lead (reversible; hidden from the default list) or unarchive it. Pass archived=false to restore.',
    { id: z.number(), archived: z.boolean().describe('true to archive, false to unarchive.') },
    async (args) => ({ content: [{ type: 'text', text: await worklists.archiveLead(args) }] }),
  );

  // --- Customers (CRUD; writes are admin-only server-side) ---

  server.tool(
    'tempo_list_customers',
    'List customers with their id, name, internal flag, and ad-hoc hourly rate. Use this to resolve a customer_id from a name (needed by tempo_create_ticket, tempo_create_project, etc.). Pass `query` to filter by a case-insensitive name substring.',
    {
      query: z.string().optional().describe('Case-insensitive substring of the customer name.'),
      include_internal: z.boolean().optional().describe('Set false to hide internal (non-billed) customers. Default: show all.'),
    },
    async (args) => ({ content: [{ type: 'text', text: await entities.listCustomers(args) }] }),
  );

  server.tool(
    'tempo_create_customer',
    'Create a customer. Only name is required. Set is_internal for a department / internal project (no client portal or invoicing). ad_hoc_hourly_rate is the default spot rate. Admin only.',
    {
      name: z.string(),
      ad_hoc_hourly_rate: z.number().optional(),
      is_internal: z.boolean().optional(),
    },
    async (args) => ({ content: [{ type: 'text', text: await entities.createCustomer(args) }] }),
  );

  server.tool(
    'tempo_update_customer',
    'Update a customer\'s name, ad-hoc rate, or internal flag. Pass only the fields to change. Admin only.',
    {
      id: z.number(),
      name: z.string().optional(),
      ad_hoc_hourly_rate: z.number().optional(),
      is_internal: z.boolean().optional(),
    },
    async (args) => ({ content: [{ type: 'text', text: await entities.updateCustomer(args) }] }),
  );

  server.tool(
    'tempo_delete_customer',
    'Permanently delete a customer. Irreversible and high-impact (projects, tickets, and invoicing reference customers) — confirm with the operator first. Admin only.',
    { id: z.number() },
    async (args) => ({ content: [{ type: 'text', text: await entities.deleteCustomer(args) }] }),
  );

  // --- Projects (write side; list via tempo_list_projects) ---

  server.tool(
    'tempo_create_project',
    'Create a project (one project = one board). Requires customer_id (resolve via tempo_list_customers), a short code (e.g. "TEMPO"), and a name. Admin only.',
    {
      customer_id: z.number(),
      code: z.string().describe('Short board code, e.g. "TEMPO", "KYTE".'),
      name: z.string(),
    },
    async (args) => ({ content: [{ type: 'text', text: await entities.createProject(args) }] }),
  );

  server.tool(
    'tempo_update_project',
    'Rename a project or change its code. Pass only the field(s) to change (the other is preserved). Admin only.',
    {
      id: z.number(),
      code: z.string().optional(),
      name: z.string().optional(),
    },
    async (args) => ({ content: [{ type: 'text', text: await entities.updateProject(args) }] }),
  );

  server.tool(
    'tempo_delete_project',
    'Permanently delete a project and its board. Irreversible — confirm with the operator first. Admin only.',
    { id: z.number() },
    async (args) => ({ content: [{ type: 'text', text: await entities.deleteProject(args) }] }),
  );

  // --- Designs (epic #379) — UI/UX mockup authoring (A-path) ---

  server.tool(
    'tempo_list_designs',
    'List the UI/UX designs (mockups) on a project board. Each design has its own version train (v1, v2, …). Returns id, frame type, version count, and title.',
    { project_id: z.number() },
    async (args) => ({ content: [{ type: 'text', text: await designs.listDesigns(args) }] }),
  );

  server.tool(
    'tempo_create_design',
    'Create a new UI/UX design (mockup) on a project board. Starts with an empty draft v1 you then populate with tempo_author_design_screens. frame_type is "mobile" (default) for now.',
    {
      project_id: z.number(),
      title: z.string().describe('e.g. "Mobile App 1", "Web App".'),
      frame_type: z.enum(['mobile', 'web', 'tablet']).optional(),
    },
    async (args) => ({ content: [{ type: 'text', text: await designs.createDesign(args) }] }),
  );

  server.tool(
    'tempo_get_design',
    'Read a design in full — its versions (with status draft/shared/approved), and the current version\'s screens + OPEN feedback. Read this before revising so you see the reviewer\'s pins to address.',
    { design_id: z.number() },
    async (args) => ({ content: [{ type: 'text', text: await designs.getDesign(args) }] }),
  );

  server.tool(
    'tempo_author_design_screens',
    'Author screens for a design against the shell template. Each screen is a STATIC HTML fragment (Tailwind classes; the shell provides Tailwind/fonts/frame — do NOT include <html>/<head>/<script>/nav chrome). Screens are sanitized server-side and upserted by screen_key. Lands in a DRAFT version (propose-not-publish); if the current version is already shared/approved, a new carry-forward draft is created automatically. Pass publish:true to mark the version SHARED (client-visible) in one step.',
    {
      design_id: z.number(),
      screens: z.array(z.object({
        screen_key: z.string().describe('stable slug within the design, e.g. "home", "settings"'),
        title: z.string().optional(),
        html: z.string().describe('static HTML fragment for this one screen (Tailwind classes, no JS)'),
        position: z.number().optional(),
      })).describe('The full ordered set of screens for this version (upsert by screen_key; omitted keys are removed).'),
      version: z.number().optional().describe('Target an existing draft version number; omit to use/auto-create the working draft.'),
      changelog: z.string().optional(),
      publish: z.boolean().optional().describe('Mark the version SHARED after authoring so clients/share-links can see it.'),
    },
    async (args) => ({ content: [{ type: 'text', text: await designs.authorDesignScreens(args) }] }),
  );

  server.tool(
    'tempo_create_design_share',
    'Create a public share link for a design so a client can review the SHARED version and leave pin feedback (no login). permission: "view" (read-only), "comment" (default, can pin), or "ai". Set ai_enabled to expose the AI revise button to the client (produces team-visible draft suggestions). Returns the /preview/{token} URL.',
    {
      design_id: z.number(),
      permission: z.enum(['view', 'comment', 'ai']).optional(),
      ai_enabled: z.boolean().optional(),
      expires_at: z.string().optional().describe('ISO datetime; omit for no expiry.'),
    },
    async (args) => ({ content: [{ type: 'text', text: await designs.createDesignShare(args) }] }),
  );

  // --- Connect transport ---

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[keyq-tempo-mcp] Connected (sprint-mode v1.8.0)');
}

main().catch((err) => {
  console.error('[keyq-tempo-mcp] Fatal:', err);
  process.exit(1);
});
