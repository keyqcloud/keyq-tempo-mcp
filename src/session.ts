import { basename } from 'node:path';
import { api } from './api.js';

export interface SessionInfo {
  session_id: number;
  short_code: string;
}

export async function registerSession(): Promise<SessionInfo> {
  const cwd = process.cwd();
  const r = await api.post<{ session_id: number; short_code: string }>('/mcp/sessions', {
    display_name: basename(cwd) || 'claude-code',
    cwd,
  });
  return { session_id: r.session_id, short_code: r.short_code };
}

export async function heartbeat(sessionId: number, activity?: string): Promise<void> {
  try {
    await api.post(`/mcp/sessions/${sessionId}/heartbeat`, { activity });
  } catch { /* swallow — best effort */ }
}

export async function terminateSession(sessionId: number): Promise<void> {
  try {
    await api.post(`/mcp/sessions/${sessionId}/terminate`, {});
  } catch { /* swallow */ }
}

export function startHeartbeatLoop(sessionId: number, intervalMs = 60_000): NodeJS.Timeout {
  return setInterval(() => heartbeat(sessionId), intervalMs);
}
