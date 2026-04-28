import { api } from '../api.js';

interface Customer { id: number; name: string; is_internal?: number; }
interface Ticket {
  id: number; customer_id: number; customer_name: string; title: string;
  description: string; type: string; priority: string; status: string;
  assigned_to: number | null; assignee_name: string | null;
  created_at: string; updated_at: string;
}
interface TicketDetail extends Ticket { comments?: { user_name: string | null; content: string; created_at: string }[]; tags?: { name: string }[] }
interface Card {
  id: number; column_id: number; project_id: number; title: string;
  description: string | null; assignee_initials: string | null; assignee_name: string | null;
  priority: string; due_date: string | null; completed_at: string | null;
}
interface Task {
  id: number; title: string; notes: string | null; customer_name: string | null;
  assignee_name: string | null; status: string; due_date: string | null;
  is_global: number; created_at: string;
}
interface Meeting {
  id: number; title: string; summary: string | null; meeting_date: string;
  duration: number; recording_url: string | null; invitees: string; action_items: string;
  customer_id: number | null; customer_name?: string | null;
}
interface Document {
  id: number; customer_id: number; filename: string; size_bytes: number;
  content_type: string | null; uploaded_by_name: string | null;
  public_token: string | null; created_at: string;
}
interface Attachment {
  id: number; parent_type: string; parent_id: number; filename: string;
  size_bytes: number; content_type: string | null;
  uploaded_by_name: string | null; source_email: string | null; created_at: string;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function isTextish(contentType: string | null): boolean {
  if (!contentType) return false;
  return /^text\//i.test(contentType)
    || /\bjson\b/i.test(contentType)
    || /\bxml\b/i.test(contentType)
    || /\bjavascript\b/i.test(contentType)
    || /\bcsv\b/i.test(contentType);
}

const MAX_INLINE_BYTES = 64 * 1024;

// --- Customers ---

export async function listCustomers(): Promise<string> {
  const rows = await api.get<Customer[]>('/customers');
  if (rows.length === 0) return 'No customers.';
  return rows.map((c) => `${c.id}. ${c.name}${c.is_internal ? ' [Internal]' : ''}`).join('\n');
}

// --- Tickets ---

export async function listTickets(opts: { customer_id?: number; status?: string }): Promise<string> {
  const params: string[] = [];
  if (opts.customer_id) params.push(`customer_id=${opts.customer_id}`);
  if (opts.status) params.push(`status=${opts.status}`);
  const url = '/tickets' + (params.length ? '?' + params.join('&') : '');
  const rows = await api.get<Ticket[]>(url);
  if (rows.length === 0) return 'No tickets.';
  return rows.map((t) =>
    `#${t.id} [${t.status}] (${t.priority}) ${t.title} — ${t.customer_name}` +
    `${t.assignee_name ? ` — assigned to ${t.assignee_name}` : ''}`
  ).join('\n');
}

export async function getTicket(opts: { id: number }): Promise<string> {
  const t = await api.get<TicketDetail>(`/tickets/${opts.id}`);
  const lines = [
    `# Ticket #${t.id}: ${t.title}`,
    `Customer: ${t.customer_name}`,
    `Type: ${t.type} | Priority: ${t.priority} | Status: ${t.status}`,
    t.assignee_name ? `Assigned to: ${t.assignee_name}` : 'Unassigned',
    `Created: ${t.created_at}  Updated: ${t.updated_at}`,
    '',
    '## Description',
    t.description || '(no description)',
  ];
  if (t.tags?.length) lines.push('', `Tags: ${t.tags.map((tg) => tg.name).join(', ')}`);
  if (t.comments?.length) {
    lines.push('', '## Comments');
    for (const c of t.comments) {
      lines.push(`- ${c.user_name || 'User'} (${c.created_at}): ${c.content}`);
    }
  }
  return lines.join('\n');
}

export async function createTicket(opts: {
  customer_id: number; title: string; description?: string; type?: string; priority?: string;
}): Promise<string> {
  const r = await api.post<{ ok: boolean; id: number }>('/tickets', {
    customer_id: opts.customer_id,
    title: opts.title,
    description: opts.description || '',
    type: opts.type || 'support',
    priority: opts.priority || 'medium',
    assigned_to: null,
  });
  return `Created ticket #${r.id}.`;
}

// --- Cards ---

export async function listCards(opts: { project_id?: number; customer_id?: number }): Promise<string> {
  // /projects/:id/board returns columns + cards. If no project specified, list projects first.
  if (opts.project_id) {
    const board = await api.get<{ columns: { id: number; name: string; display_group: string }[]; cards: Card[] }>(
      `/projects/${opts.project_id}/board`
    );
    if (board.cards.length === 0) return 'No cards.';
    const colMap = new Map(board.columns.map((c) => [c.id, c.name]));
    return board.cards.map((c) =>
      `#${c.id} [${colMap.get(c.column_id) || 'unknown'}] ${c.title}` +
      `${c.assignee_name ? ` — ${c.assignee_name}` : ''}` +
      `${c.due_date ? ` — due ${c.due_date}` : ''}`
    ).join('\n');
  }
  // fallback: list projects so user can pick
  const params = opts.customer_id ? `?customer_id=${opts.customer_id}` : '';
  const projects = await api.get<{ id: number; code: string; name: string; customer_id: number }[]>(`/projects${params}`);
  if (projects.length === 0) return 'No projects.';
  return 'Specify project_id. Available projects:\n' +
    projects.map((p) => `${p.id}. ${p.code} — ${p.name}`).join('\n');
}

export async function getCard(opts: { id: number; project_id: number }): Promise<string> {
  // Cards endpoint is project-scoped via the board.
  const board = await api.get<{ columns: { id: number; name: string }[]; cards: Card[] }>(
    `/projects/${opts.project_id}/board`
  );
  const card = board.cards.find((c) => c.id === opts.id);
  if (!card) return `Card #${opts.id} not found in project ${opts.project_id}.`;
  const colName = board.columns.find((c) => c.id === card.column_id)?.name || 'unknown';
  return [
    `# Card #${card.id}: ${card.title}`,
    `Column: ${colName}`,
    `Priority: ${card.priority}${card.due_date ? ` | Due: ${card.due_date}` : ''}`,
    card.assignee_name ? `Assigned to: ${card.assignee_name}` : 'Unassigned',
    card.completed_at ? `Completed: ${card.completed_at}` : '',
    '',
    '## Description',
    card.description || '(no description)',
  ].filter(Boolean).join('\n');
}

// --- Tasks ---

export async function listTasks(opts: { status?: string; customer_id?: number }): Promise<string> {
  const rows = await api.get<Task[]>('/tasks');
  let filtered = rows;
  if (opts.status) filtered = filtered.filter((t) => t.status === opts.status);
  if (opts.customer_id) filtered = filtered.filter((t) => (t as Task & { customer_id?: number }).customer_id === opts.customer_id);
  if (filtered.length === 0) return 'No tasks.';
  return filtered.map((t) =>
    `#${t.id} [${t.status}] ${t.title}` +
    `${t.customer_name ? ` — ${t.customer_name}` : ''}` +
    `${t.assignee_name ? ` — ${t.assignee_name}` : t.is_global ? ' — global' : ''}` +
    `${t.due_date ? ` — due ${t.due_date}` : ''}`
  ).join('\n');
}

export async function getTask(opts: { id: number }): Promise<string> {
  const rows = await api.get<Task[]>('/tasks');
  const task = rows.find((t) => t.id === opts.id);
  if (!task) return `Task #${opts.id} not found.`;
  return [
    `# Task #${task.id}: ${task.title}`,
    `Status: ${task.status}${task.due_date ? ` | Due: ${task.due_date}` : ''}`,
    task.customer_name ? `Customer: ${task.customer_name}` : '',
    task.assignee_name ? `Assigned to: ${task.assignee_name}` : task.is_global ? 'Global (anyone can claim)' : 'Unassigned',
    '',
    '## Notes',
    task.notes || '(no notes)',
  ].filter(Boolean).join('\n');
}

export async function createTask(opts: {
  title: string; notes?: string; customer_id?: number; due_date?: string; is_global?: boolean;
}): Promise<string> {
  const r = await api.post<{ ok: boolean; id: number }>('/tasks', {
    title: opts.title,
    notes: opts.notes || null,
    customer_id: opts.customer_id || null,
    assigned_to: null,
    is_global: !!opts.is_global,
    status: 'pending',
    due_date: opts.due_date || null,
  });
  return `Created task #${r.id}.`;
}

// --- Meetings ---

export async function listMeetings(opts: { customer_id?: number; limit?: number }): Promise<string> {
  const params: string[] = [];
  if (opts.customer_id) params.push(`customer_id=${opts.customer_id}`);
  const url = '/fathom/meetings' + (params.length ? '?' + params.join('&') : '');
  const rows = await api.get<Meeting[]>(url);
  const limit = opts.limit ?? 20;
  if (rows.length === 0) return 'No meetings.';
  return rows.slice(0, limit).map((m) => {
    const mins = Math.round((m.duration || 0) / 60);
    return `#${m.id} ${m.meeting_date.slice(0, 10)} (${mins}m) — ${m.title}` +
      `${m.customer_name ? ` — ${m.customer_name}` : ''}`;
  }).join('\n');
}

export async function getMeeting(opts: { id: number }): Promise<string> {
  const rows = await api.get<Meeting[]>('/fathom/meetings');
  const m = rows.find((x) => x.id === opts.id);
  if (!m) return `Meeting #${opts.id} not found.`;
  const invitees = (() => { try { return JSON.parse(m.invitees) as { name?: string; email: string }[]; } catch { return []; } })();
  const actions = (() => { try { return JSON.parse(m.action_items) as { description: string; assignee?: string; completed: boolean }[]; } catch { return []; } })();
  const lines = [
    `# Meeting #${m.id}: ${m.title}`,
    `Date: ${m.meeting_date} | Duration: ${Math.round((m.duration || 0) / 60)}m`,
    m.customer_name ? `Customer: ${m.customer_name}` : '',
    m.recording_url ? `Recording: ${m.recording_url}` : '',
  ].filter(Boolean);
  if (invitees.length) lines.push('', `Attendees: ${invitees.map((i) => i.name || i.email).join(', ')}`);
  if (m.summary) lines.push('', '## Summary', m.summary);
  if (actions.length) {
    lines.push('', '## Action items');
    for (const a of actions) {
      const mark = a.completed ? '[x]' : '[ ]';
      lines.push(`${mark} ${a.description}${a.assignee ? ` (${a.assignee})` : ''}`);
    }
  }
  return lines.join('\n');
}

// --- Documents ---

export async function listDocuments(opts: { customer_id: number }): Promise<string> {
  const rows = await api.get<Document[]>(`/customers/${opts.customer_id}/documents`);
  if (rows.length === 0) return 'No documents.';
  return rows.map((d) =>
    `#${d.id} ${d.filename} (${fmtBytes(d.size_bytes)}, ${d.content_type || 'unknown'})` +
    `${d.uploaded_by_name ? ` — ${d.uploaded_by_name}` : ''}` +
    ` — ${d.created_at.slice(0, 10)}`
  ).join('\n');
}

export async function readDocument(opts: { id: number }): Promise<string> {
  const res = await api.fetchRaw(`/documents/${opts.id}/download`);
  const contentType = res.headers.get('content-type');
  const sizeHeader = res.headers.get('content-length');
  if (!isTextish(contentType)) {
    return `Document #${opts.id} is binary (${contentType || 'unknown'}, ${sizeHeader ? fmtBytes(Number(sizeHeader)) : 'unknown size'}). Cannot inline.`;
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_INLINE_BYTES) {
    const head = new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, MAX_INLINE_BYTES));
    return `[file truncated to first ${fmtBytes(MAX_INLINE_BYTES)} of ${fmtBytes(buf.byteLength)}]\n\n${head}`;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}

// --- Attachments ---

export async function listAttachments(opts: { parent_type: 'inbox' | 'ticket' | 'card' | 'task'; parent_id: number }): Promise<string> {
  const rows = await api.get<Attachment[]>(`/attachments?parent_type=${opts.parent_type}&parent_id=${opts.parent_id}`);
  if (rows.length === 0) return 'No attachments.';
  return rows.map((a) =>
    `#${a.id} ${a.filename} (${fmtBytes(a.size_bytes)}, ${a.content_type || 'unknown'})` +
    `${a.source_email ? ` — from ${a.source_email}` : ''}` +
    ` — ${a.created_at.slice(0, 10)}`
  ).join('\n');
}

export async function readAttachment(opts: { id: number }): Promise<string> {
  const res = await api.fetchRaw(`/attachments/${opts.id}/download`);
  const contentType = res.headers.get('content-type');
  const sizeHeader = res.headers.get('content-length');
  if (!isTextish(contentType)) {
    return `Attachment #${opts.id} is binary (${contentType || 'unknown'}, ${sizeHeader ? fmtBytes(Number(sizeHeader)) : 'unknown size'}). Cannot inline.`;
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_INLINE_BYTES) {
    const head = new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, MAX_INLINE_BYTES));
    return `[file truncated to first ${fmtBytes(MAX_INLINE_BYTES)} of ${fmtBytes(buf.byteLength)}]\n\n${head}`;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}
