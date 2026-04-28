import { api } from '../api.js';

const POLL_WAIT_SECS = 30; // server-side long-poll window
const MAX_TOTAL_WAIT_MS = 30 * 60 * 1000; // 30 min total before giving up

interface QuestionResult {
  status: 'answered' | 'expired' | 'canceled' | 'pending';
  response: string | null;
}

async function createQuestion(sessionId: number, type: 'ask' | 'approve' | 'notify', question: string): Promise<number> {
  const r = await api.post<{ id: number }>('/mcp/questions', {
    session_id: sessionId,
    type,
    question,
  });
  return r.id;
}

async function pollForResponse(questionId: number): Promise<QuestionResult> {
  const start = Date.now();
  while (Date.now() - start < MAX_TOTAL_WAIT_MS) {
    const r = await api.get<QuestionResult>(
      `/mcp/questions/${questionId}?wait=${POLL_WAIT_SECS}`,
      { timeoutMs: (POLL_WAIT_SECS + 5) * 1000 },
    );
    if (r.status !== 'pending') return r;
  }
  return { status: 'pending', response: null };
}

export async function handleAsk(sessionId: number, params: { question: string; context?: string }): Promise<string> {
  const fullQuestion = params.context ? `${params.question}\n\n--- Context ---\n${params.context}` : params.question;
  const id = await createQuestion(sessionId, 'ask', fullQuestion);
  const r = await pollForResponse(id);
  if (r.status === 'answered') return r.response ?? '';
  if (r.status === 'canceled') return '[user canceled the question]';
  if (r.status === 'expired') return '[question expired without a response]';
  return '[no response yet — exceeded MCP tool wait time; the user may answer later via Tempo web]';
}

export async function handleApprove(sessionId: number, params: { question: string; context?: string }): Promise<string> {
  const fullQuestion = params.context ? `${params.question}\n\n--- Context ---\n${params.context}` : params.question;
  const id = await createQuestion(sessionId, 'approve', fullQuestion);
  const r = await pollForResponse(id);
  if (r.status === 'answered') return r.response ?? '';
  if (r.status === 'canceled') return '[user canceled the approval]';
  if (r.status === 'expired') return '[approval expired without a response]';
  return '[no response yet — exceeded MCP tool wait time]';
}

export async function handleNotify(sessionId: number, params: { message: string }): Promise<string> {
  await createQuestion(sessionId, 'notify', params.message);
  return 'Sent.';
}
