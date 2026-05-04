// Sprint-mode tools. Each is a thin wrapper around a Tempo API endpoint;
// the MCP layer's job is JSON-in/JSON-out + the move-by-name resolution
// (column names → ids) that the API itself doesn't do.

import { api, ApiError } from '../api.js';

interface BoardColumn { id: number; name: string; display_group: string; position: number }
interface BoardCard {
  id: number; column_id: number; project_id: number; title: string;
  description: string | null; assignee_id: number | null;
  assignee_initials: string | null; assignee_name: string | null;
  priority: string; due_date: string | null; position: number;
  column_name?: string | null; display_group?: string | null;
  project_code?: string | null; project_name?: string | null;
  comments?: unknown[]; attachments?: unknown[];
}

function pretty(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

export async function nextCard(args: { project_id: number; assignee_initials?: string }): Promise<string> {
  const qs = new URLSearchParams();
  qs.set('project_id', String(args.project_id));
  if (args.assignee_initials) qs.set('assignee_initials', args.assignee_initials);
  const r = await api.get<{ card: BoardCard | null; reason?: string }>(`/board-cards/next?${qs}`);
  if (!r.card) return r.reason || 'No card available.';
  return pretty(r.card);
}

export async function getCard(args: { id: number }): Promise<string> {
  const r = await api.get<BoardCard>(`/board-cards/${args.id}`);
  return pretty(r);
}

export async function listCards(args: { project_id: number }): Promise<string> {
  const r = await api.get<{ columns: BoardColumn[]; cards: BoardCard[] }>(`/projects/${args.project_id}/board`);
  return pretty(r);
}

export async function createCard(args: {
  project_id: number;
  column_id?: number;
  column_name?: string;
  title: string;
  description?: string;
  assignee_id?: number;
  priority?: string;
  due_date?: string;
}): Promise<string> {
  let columnId = args.column_id;
  if (!columnId && args.column_name) {
    columnId = await resolveColumnId(args.project_id, args.column_name);
  }
  if (!columnId) {
    // Default to first column on the board.
    const board = await api.get<{ columns: BoardColumn[] }>(`/projects/${args.project_id}/board`);
    if (!board.columns.length) throw new ApiError(400, `Project ${args.project_id} has no board columns yet.`);
    columnId = board.columns[0].id;
  }
  const body = {
    column_id: columnId,
    title: args.title,
    description: args.description ?? null,
    assignee_id: args.assignee_id ?? null,
    priority: args.priority ?? 'medium',
    due_date: args.due_date ?? null,
  };
  const r = await api.post<{ ok: boolean; id: number }>(`/projects/${args.project_id}/cards`, body);
  return pretty({ ok: true, card_id: r.id });
}

export async function updateCard(args: {
  id: number;
  title?: string;
  description?: string;
  assignee_id?: number | null;
  priority?: string;
  due_date?: string | null;
}): Promise<string> {
  const body: Record<string, unknown> = {};
  if (args.title !== undefined) body.title = args.title;
  if (args.description !== undefined) body.description = args.description;
  if (args.assignee_id !== undefined) body.assignee_id = args.assignee_id;
  if (args.priority !== undefined) body.priority = args.priority;
  if (args.due_date !== undefined) body.due_date = args.due_date;
  await api.put(`/board-cards/${args.id}`, body);
  return pretty({ ok: true });
}

export async function commentCard(args: { id: number; content: string }): Promise<string> {
  const r = await api.post<{ ok: boolean; id: number }>(`/board-cards/${args.id}/comments`, { content: args.content });
  return pretty({ ok: true, comment_id: r.id });
}

// Accepts a column name OR a display_group ('up_next', 'in_progress',
// 'in_review', 'blocked', 'completed', 'other'). Resolves to column_id by
// fetching the board, then issues the move.
export async function moveCard(args: { id: number; target_column: string }): Promise<string> {
  const card = await api.get<BoardCard>(`/board-cards/${args.id}`);
  const columnId = await resolveColumnId(card.project_id, args.target_column);
  await api.put(`/board-cards/${args.id}/move`, { column_id: columnId, position: 0 });
  return pretty({ ok: true, moved_to_column_id: columnId });
}

export async function emailStuck(args: { id: number; blocker: string }): Promise<string> {
  const r = await api.post<{ ok: boolean; comment_posted: boolean; email_sent: boolean }>(
    `/board-cards/${args.id}/email-stuck`,
    { blocker: args.blocker },
  );
  return pretty(r);
}

async function resolveColumnId(projectId: number, target: string): Promise<number> {
  const board = await api.get<{ columns: BoardColumn[] }>(`/projects/${projectId}/board`);
  const lower = target.toLowerCase();
  // Exact name match first, then display_group, then case-insensitive name.
  const exact = board.columns.find((c) => c.name === target);
  if (exact) return exact.id;
  const byGroup = board.columns.find((c) => c.display_group === lower);
  if (byGroup) return byGroup.id;
  const ci = board.columns.find((c) => c.name.toLowerCase() === lower);
  if (ci) return ci.id;
  const available = board.columns.map((c) => `"${c.name}" (${c.display_group})`).join(', ');
  throw new ApiError(400, `No column matching "${target}" on project ${projectId}. Available: ${available}`);
}
