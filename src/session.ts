import { basename } from 'node:path';
import { api, ApiError } from './api.js';

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

export async function heartbeat(sessionId: number, activity?: string): Promise<{ terminated?: boolean }> {
  try {
    await api.post(`/mcp/sessions/${sessionId}/heartbeat`, { activity });
    return {};
  } catch (e) {
    // If the server says the session is terminated (410), the MCP should stop
    // beating a dead horse — caller can use this signal to exit the process.
    if (e instanceof ApiError && e.status === 410) return { terminated: true };
    return {};
  }
}

export async function terminateSession(sessionId: number): Promise<void> {
  try {
    await api.post(`/mcp/sessions/${sessionId}/terminate`, {});
  } catch { /* swallow */ }
}

export function startHeartbeatLoop(sessionId: number, intervalMs = 60_000, onTerminated?: () => void): NodeJS.Timeout {
  return setInterval(async () => {
    const r = await heartbeat(sessionId);
    if (r.terminated && onTerminated) onTerminated();
  }, intervalMs);
}
