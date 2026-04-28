import { getApiUrl, readToken } from './config.js';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function authHeader(): Record<string, string> {
  const token = readToken();
  if (!token) {
    throw new ApiError(401, 'Not enrolled. Run: npx keyq-tempo-mcp enroll <code>');
  }
  return { Authorization: `Bearer ${token}` };
}

async function call<T>(method: string, path: string, body?: unknown, opts?: { auth?: boolean; raw?: boolean; timeoutMs?: number }): Promise<T> {
  const url = `${getApiUrl()}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts?.auth !== false) Object.assign(headers, authHeader());

  const controller = opts?.timeoutMs ? new AbortController() : undefined;
  const timer = controller && opts?.timeoutMs
    ? setTimeout(() => controller.abort(), opts.timeoutMs) : undefined;

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller?.signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, data.error || `${method} ${path} failed (${res.status})`);
    }
    if (opts?.raw) return res as unknown as T;
    return await res.json() as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const api = {
  get: <T>(path: string, opts?: { auth?: boolean; timeoutMs?: number }) => call<T>('GET', path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: { auth?: boolean }) => call<T>('POST', path, body, opts),
  put: <T>(path: string, body?: unknown) => call<T>('PUT', path, body),
  delete: <T>(path: string) => call<T>('DELETE', path),
  fetchRaw: (path: string) => call<Response>('GET', path, undefined, { raw: true }),
};
