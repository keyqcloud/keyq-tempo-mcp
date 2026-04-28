import { api } from '../api.js';

const POLL_WAIT_SECS = 30; // server-side long-poll window
const MAX_TOTAL_WAIT_MS = 30 * 60 * 1000; // 30 min total before giving up

interface QuestionResult {
  status: 'answered' | 'expired' | 'canceled' | 'pending';
  response: string | null;
}

async function createAndAwait(sessionId: number, type: 'ask' | 'approve' | 'notify', question: string): Promise<QuestionResult | { id: number }> {
  const created = await api.post<{ id: number }>('/mcp/questions', {
    session_id: sessionId,
    type,
    question,
  });
  if (type === 'notify') return { id: created.id };

  const start = Date.now();
  while (Date.now() - start < MAX_TOTAL_WAIT_MS) {
    const r = await api.get<QuestionResult>(`/mcp/questions/${created.id}?wait=${POLL_WAIT_SECS}`, { timeoutMs: (POLL_WAIT_SECS + 5) * 1000 });
    if (r.status !== 'pending') return r;
  }
  return { status: 'pending', response: null };
}

export async function handleAsk(sessionId: number, params: { question: string; context?: string }): Promise<string> {
  const fullQuestion = params.context ? `${params.question}\n\n--- Context ---\n${params.context}` : params.question;
  const r = await createAndAwait(sessionId, 'ask', fullQuestion);
  if ('id' in r) return 'Notification sent.';
  if (r.status === 'answered') return r.response ?? '';
  if (r.status === 'canceled') return '[user canceled the question]';
  if (r.status === 'expired') return '[question expired without a response]';
  return '[no response yet — exceeded MCP tool wait time; the user may answer later via Tempo web]';
}

export async function handleApprove(sessionId: number, params: { question: string; context?: string }): Promise<string> {
  const fullQuestion = params.context ? `${params.question}\n\n--- Context ---\n${params.context}` : params.question;
  const r = await createAndAwait(sessionId, 'approve', fullQuestion);
  if ('id' in r) return 'Notification sent.';
  if (r.status === 'answered') return r.response ?? '';
  if (r.status === 'canceled') return '[user canceled the approval]';
  if (r.status === 'expired') return '[approval expired without a response]';
  return '[no response yet — exceeded MCP tool wait time]';
}

export async function handleNotify(sessionId: number, params: { message: string }): Promise<string> {
  await createAndAwait(sessionId, 'notify', params.message);
  return 'Sent.';
}
