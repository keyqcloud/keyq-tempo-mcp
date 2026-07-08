// Tasks, support tickets, and leads — the operator's non-card work lists.
// Thin wrappers over the API's /tasks, /tickets, and /leads routes (device
// token = the user; role-scoped server-side). Distinct from sprint cards
// (sprint.ts), which live on project boards.

import { api } from '../api.js';

// ---------------------------------------------------------------------------
// Tasks (freeform to-dos; /tasks)
// ---------------------------------------------------------------------------

interface Task {
  id: number; title: string; notes: string | null; status: string;
  customer_id: number | null; customer_name: string | null;
  assigned_to: number | null; assignee_initials: string | null; assignee_name: string | null;
  is_global: number; due_date: string | null; completed_at: string | null;
  creator_name: string | null; created_at: string;
}

export async function listTasks(opts: { status?: string; assignee_id?: number; include_completed?: boolean }): Promise<string> {
  let tasks = await api.get<Task[]>('/tasks');
  if (opts.status) tasks = tasks.filter((t) => t.status === opts.status);
  else if (!opts.include_completed) tasks = tasks.filter((t) => t.status !== 'completed');
  if (opts.assignee_id) tasks = tasks.filter((t) => t.assigned_to === opts.assignee_id);
  if (tasks.length === 0) return 'No matching tasks.';
  return tasks.map((t) => {
    const who = t.is_global ? '[global]' : (t.assignee_initials || t.assignee_name || 'unassigned');
    const meta = [
      t.status,
      t.due_date ? `due ${t.due_date.slice(0, 10)}` : '',
      t.customer_name ? `for ${t.customer_name}` : '',
      who,
    ].filter(Boolean).join(' · ');
    return `#${t.id} ${t.title}\n    ${meta}${t.notes ? `\n    ${t.notes.slice(0, 120)}` : ''}`;
  }).join('\n');
}

export async function createTask(opts: {
  title: string; notes?: string; status?: string; assigned_to?: number;
  customer_id?: number; is_global?: boolean; due_date?: string;
}): Promise<string> {
  const res = await api.post<{ ok: boolean; id: number }>('/tasks', opts);
  return `Created task #${res.id}: ${opts.title}`;
}

export async function updateTask(opts: {
  id: number; title?: string; notes?: string; status?: string;
  assigned_to?: number | null; customer_id?: number | null; is_global?: boolean; due_date?: string | null;
}): Promise<string> {
  const { id, ...fields } = opts;
  await api.put(`/tasks/${id}`, fields);
  return `Updated task #${id}.`;
}

export async function deleteTask(opts: { id: number }): Promise<string> {
  await api.delete(`/tasks/${opts.id}`);
  return `Deleted task #${opts.id}.`;
}

// ---------------------------------------------------------------------------
// Support tickets (/tickets)
// ---------------------------------------------------------------------------

interface TicketTag { id: number; name: string; color: string | null }
interface TicketComment { id: number; content: string; user_name: string; user_role: string; created_at: string }
interface Ticket {
  id: number; title: string; description: string | null; type: string; priority: string; status: string;
  customer_id: number | null; customer_name: string | null;
  reporter_name: string | null; reporter_email: string | null;
  assigned_to: number | null; assignee_initials: string | null; assignee_name: string | null;
  board_card_id: number | null; created_at: string;
  tags?: TicketTag[]; comments?: TicketComment[];
}

export async function listTickets(opts: { status?: string; customer_id?: number }): Promise<string> {
  const qs = new URLSearchParams();
  if (opts.status) qs.set('status', opts.status);
  if (opts.customer_id) qs.set('customer_id', String(opts.customer_id));
  const url = '/tickets' + (qs.toString() ? `?${qs}` : '');
  const tickets = await api.get<Ticket[]>(url);
  if (tickets.length === 0) return 'No matching tickets.';
  return tickets.map((t) => {
    const meta = [
      t.status, t.priority, t.type,
      t.customer_name ? `— ${t.customer_name}` : '',
      t.assignee_initials ? `@${t.assignee_initials}` : 'unassigned',
      (t.tags && t.tags.length) ? `[${t.tags.map((g) => g.name).join(', ')}]` : '',
    ].filter(Boolean).join(' · ');
    return `#${t.id} ${t.title}\n    ${meta}`;
  }).join('\n');
}

export async function getTicket(opts: { id: number }): Promise<string> {
  const t = await api.get<Ticket>(`/tickets/${opts.id}`);
  const lines = [
    `# Ticket #${t.id}: ${t.title}`,
    `Status: ${t.status} | Priority: ${t.priority} | Type: ${t.type}`,
    t.customer_name ? `Customer: ${t.customer_name}` : '',
    t.reporter_name ? `Reporter: ${t.reporter_name}${t.reporter_email ? ` <${t.reporter_email}>` : ''}` : '',
    t.assignee_name ? `Assignee: ${t.assignee_name} (${t.assignee_initials})` : 'Assignee: unassigned',
    (t.tags && t.tags.length) ? `Tags: ${t.tags.map((g) => g.name).join(', ')}` : '',
    t.board_card_id ? `Linked card: #${t.board_card_id}` : '',
  ].filter(Boolean);
  if (t.description) lines.push('', '## Description', t.description);
  if (t.comments && t.comments.length) {
    lines.push('', '## Comments');
    for (const c of t.comments) {
      lines.push(`[${c.created_at.slice(0, 16).replace('T', ' ')}] ${c.user_name} (${c.user_role}): ${c.content}`);
    }
  }
  return lines.join('\n');
}

export async function createTicket(opts: {
  customer_id: number; title: string; description?: string; type?: string; priority?: string; assigned_to?: number;
}): Promise<string> {
  const res = await api.post<{ ok: boolean; id: number }>('/tickets', opts);
  return `Created ticket #${res.id}: ${opts.title}`;
}

export async function updateTicket(opts: {
  id: number; title?: string; description?: string; type?: string; priority?: string; status?: string; assigned_to?: number | null;
}): Promise<string> {
  const { id, ...fields } = opts;
  await api.put(`/tickets/${id}`, fields);
  return `Updated ticket #${id}.`;
}

export async function commentTicket(opts: { id: number; content: string }): Promise<string> {
  await api.post(`/tickets/${opts.id}/comments`, { content: opts.content });
  return `Comment added to ticket #${opts.id}.`;
}

// ---------------------------------------------------------------------------
// Leads (sales intake; /leads)
// ---------------------------------------------------------------------------

interface CustomerMatch { id: number; name: string; via: string }
interface Lead {
  id: number; name: string; email: string | null; phone: string | null; company: string | null;
  message: string; source: string; status: string;
  promoted_customer_id: number | null; promoted_customer_name: string | null;
  archived_at: string | null; created_at: string;
  customer_matches?: CustomerMatch[];
}

export async function listLeads(opts: { status?: string; archived?: boolean }): Promise<string> {
  const qs = new URLSearchParams();
  if (opts.status) qs.set('status', opts.status);
  if (opts.archived) qs.set('archived', 'true');
  const url = '/leads' + (qs.toString() ? `?${qs}` : '');
  const leads = await api.get<Lead[]>(url);
  if (leads.length === 0) return opts.archived ? 'No archived leads.' : 'No matching leads (junk/sales are hidden by default — pass status to see them).';
  return leads.map((l) => {
    const contact = l.email || l.phone || '—';
    const meta = [
      l.status,
      l.company ? `@ ${l.company}` : '',
      `via ${l.source}`,
      l.promoted_customer_name ? `→ ${l.promoted_customer_name}` : '',
      l.created_at.slice(0, 10),
    ].filter(Boolean).join(' · ');
    return `#${l.id} ${l.name} (${contact})\n    ${meta}`;
  }).join('\n');
}

export async function getLead(opts: { id: number }): Promise<string> {
  const l = await api.get<Lead>(`/leads/${opts.id}`);
  const lines = [
    `# Lead #${l.id}: ${l.name}`,
    `Status: ${l.status}${l.archived_at ? ' (archived)' : ''}`,
    l.email ? `Email: ${l.email}` : '',
    l.phone ? `Phone: ${l.phone}` : '',
    l.company ? `Company: ${l.company}` : '',
    `Source: ${l.source} · ${l.created_at.slice(0, 10)}`,
    l.promoted_customer_name ? `Promoted to: ${l.promoted_customer_name}` : '',
  ].filter(Boolean);
  if (l.message) lines.push('', '## Message', l.message);
  if (l.customer_matches && l.customer_matches.length) {
    lines.push('', '## Existing customer matches');
    for (const m of l.customer_matches) lines.push(`- ${m.name} (id ${m.id}, matched by ${m.via})`);
  }
  return lines.join('\n');
}

export async function updateLead(opts: { id: number; status: string }): Promise<string> {
  await api.put(`/leads/${opts.id}`, { status: opts.status });
  return `Lead #${opts.id} marked ${opts.status}.`;
}

export async function archiveLead(opts: { id: number; archived: boolean }): Promise<string> {
  await api.post(`/leads/${opts.id}/${opts.archived ? 'archive' : 'unarchive'}`, {});
  return `Lead #${opts.id} ${opts.archived ? 'archived' : 'unarchived'}.`;
}
