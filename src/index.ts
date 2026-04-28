import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runEnroll } from './enroll.js';
import { registerSession, terminateSession, startHeartbeatLoop } from './session.js';
import { handleAsk, handleApprove, handleNotify } from './tools/async.js';
import * as data from './tools/data.js';

async function main() {
  // Subcommands.
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

  // Default: run as MCP server.
  let session;
  try {
    session = await registerSession();
  } catch (e) {
    console.error(`[keyq-tempo-mcp] Failed to register session: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }

  const heartbeatTimer = startHeartbeatLoop(session.session_id);

  const server = new McpServer({ name: 'keyq-tempo', version: '0.1.0' });

  // --- Async (block waiting for user) ---

  server.tool(
    'ask',
    'Ask the user a question and wait for their reply via the Tempo web UI. Blocks until answered, expires after 24h pending; tool times out after 30 min wait but the user can still respond later (visible in their Tempo session history).',
    {
      question: z.string().describe('The question to ask'),
      context: z.string().optional().describe('Optional additional context'),
    },
    async ({ question, context }) => ({
      content: [{ type: 'text', text: await handleAsk(session.session_id, { question, context }) }],
    })
  );

  server.tool(
    'request_approval',
    'Request a yes/no approval from the user. Renders Yes/No buttons in the Tempo web UI. Use for go/no-go decisions before you take an action.',
    {
      question: z.string().describe('The decision needing approval'),
      context: z.string().optional().describe('Optional context for the decision'),
    },
    async ({ question, context }) => ({
      content: [{ type: 'text', text: await handleApprove(session.session_id, { question, context }) }],
    })
  );

  server.tool(
    'notify',
    'Send a fire-and-forget notification to the user (visible in Tempo web). Does not block.',
    {
      message: z.string().describe('The notification text'),
    },
    async ({ message }) => ({
      content: [{ type: 'text', text: await handleNotify(session.session_id, { message }) }],
    })
  );

  // --- Read data ---

  server.tool('list_customers', 'List KeyQ Tempo customers (id, name).', {},
    async () => ({ content: [{ type: 'text', text: await data.listCustomers() }] }));

  server.tool('list_tickets', 'List support tickets. Filter by customer_id and/or status (open|in_progress|resolved|closed).',
    { customer_id: z.number().optional(), status: z.string().optional() },
    async (args) => ({ content: [{ type: 'text', text: await data.listTickets(args) }] }));

  server.tool('get_ticket', 'Get full ticket detail including comments and tags.',
    { id: z.number() },
    async (args) => ({ content: [{ type: 'text', text: await data.getTicket(args) }] }));

  server.tool('list_cards', 'List board cards for a project. If project_id is omitted, returns the list of available projects.',
    { project_id: z.number().optional(), customer_id: z.number().optional() },
    async (args) => ({ content: [{ type: 'text', text: await data.listCards(args) }] }));

  server.tool('get_card', 'Get a board card detail (requires both id and project_id).',
    { id: z.number(), project_id: z.number() },
    async (args) => ({ content: [{ type: 'text', text: await data.getCard(args) }] }));

  server.tool('list_tasks', 'List tasks. Filter by status (pending|in_progress|blocked|completed) and/or customer_id.',
    { status: z.string().optional(), customer_id: z.number().optional() },
    async (args) => ({ content: [{ type: 'text', text: await data.listTasks(args) }] }));

  server.tool('get_task', 'Get a task detail.',
    { id: z.number() },
    async (args) => ({ content: [{ type: 'text', text: await data.getTask(args) }] }));

  server.tool('list_meetings', 'List Fathom meeting summaries. Optional customer_id filter, optional limit (default 20).',
    { customer_id: z.number().optional(), limit: z.number().optional() },
    async (args) => ({ content: [{ type: 'text', text: await data.listMeetings(args) }] }));

  server.tool('get_meeting', 'Get a meeting with summary, attendees, and action items.',
    { id: z.number() },
    async (args) => ({ content: [{ type: 'text', text: await data.getMeeting(args) }] }));

  server.tool('list_documents', 'List a customer\'s documents (requires customer_id).',
    { customer_id: z.number() },
    async (args) => ({ content: [{ type: 'text', text: await data.listDocuments(args) }] }));

  server.tool('read_document', 'Read a document\'s contents inline (text-based files only; binary returns metadata).',
    { id: z.number() },
    async (args) => ({ content: [{ type: 'text', text: await data.readDocument(args) }] }));

  server.tool('list_attachments', 'List attachments for an inbox/ticket/card/task. parent_type ∈ {inbox, ticket, card, task}.',
    {
      parent_type: z.enum(['inbox', 'ticket', 'card', 'task']),
      parent_id: z.number(),
    },
    async (args) => ({ content: [{ type: 'text', text: await data.listAttachments(args) }] }));

  server.tool('read_attachment', 'Read an attachment\'s contents inline (text-based files only).',
    { id: z.number() },
    async (args) => ({ content: [{ type: 'text', text: await data.readAttachment(args) }] }));

  // --- Write ---

  server.tool('create_ticket', 'Create a new support ticket for a customer.',
    {
      customer_id: z.number(),
      title: z.string(),
      description: z.string().optional(),
      type: z.enum(['bug', 'support', 'feature', 'other']).optional(),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    },
    async (args) => ({ content: [{ type: 'text', text: await data.createTicket(args) }] }));

  server.tool('create_task', 'Create a new task. Optional customer_id, due_date (YYYY-MM-DD), is_global (visible to all team).',
    {
      title: z.string(),
      notes: z.string().optional(),
      customer_id: z.number().optional(),
      due_date: z.string().optional(),
      is_global: z.boolean().optional(),
    },
    async (args) => ({ content: [{ type: 'text', text: await data.createTask(args) }] }));

  // --- Connect transport ---

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[keyq-tempo-mcp] Connected (session ${session.short_code} / id ${session.session_id})`);

  const shutdown = () => {
    clearInterval(heartbeatTimer);
    terminateSession(session.session_id).finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[keyq-tempo-mcp] Fatal:', err);
  process.exit(1);
});
