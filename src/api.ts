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
    throw new ApiError(401, 'Not enrolled. Run: npx @keyqinc/tempo-mcp enroll <code>');
  }
  return { Authorization: `Bearer ${token}` };
}

async function call<T>(method: string, path: string, body?: unknown, opts?: { auth?: boolean; raw?: boolean; timeoutMs?: number; bytes?: boolean }): Promise<T> {
  const url = `${getApiUrl()}${path}`;
  // `bytes`: the body is a file's raw contents, sent as-is (proposal uploads).
  const headers: Record<string, string> = { 'Content-Type': opts?.bytes ? 'application/octet-stream' : 'application/json' };
  if (opts?.auth !== false) Object.assign(headers, authHeader());

  const controller = opts?.timeoutMs ? new AbortController() : undefined;
  const timer = controller && opts?.timeoutMs
    ? setTimeout(() => controller.abort(), opts.timeoutMs) : undefined;

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : opts?.bytes ? body as unknown as BodyInit : JSON.stringify(body),
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
  patch: <T>(path: string, body?: unknown) => call<T>('PATCH', path, body),
  delete: <T>(path: string) => call<T>('DELETE', path),
  putBytes: <T>(path: string, data: Uint8Array) => call<T>('PUT', path, data, { bytes: true, timeoutMs: 120_000 }),
  fetchRaw: (path: string) => call<Response>('GET', path, undefined, { raw: true }),
};
