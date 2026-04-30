// Claude Code Stop hook that mirrors each assistant turn to KeyQ Tempo and
// implements the bridge's "Listening" mode (Phase 3d). Reads the hook input
// JSON from stdin, locates the latest assistant turn in the transcript,
// mirrors it, drains any pending inbox messages, then — if the session has
// listening_mode=1 — long-polls the wait endpoint indefinitely until either
// a new prompt arrives (returned as decision:"block") or the user toggles
// listening off in Tempo (clean exit, Claude stops).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.keyq-tempo');
const TOKEN_PATH = join(CONFIG_DIR, 'token');
const URL_PATH = join(CONFIG_DIR, 'api-url');

const DEFAULT_API_URL = 'https://tempo-api.keyq.io';

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  stop_hook_active?: boolean;
}

// A claude-code transcript entry. Schema varies slightly across versions;
// this captures the relevant shape without being strict about the rest.
interface TranscriptEntry {
  type?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type?: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  };
  // Older variants may put role/content at the top level.
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

function readToken(): string | null {
  try { return readFileSync(TOKEN_PATH, 'utf8').trim() || null; } catch { return null; }
}

function getApiUrl(): string {
  if (process.env.KEYQ_TEMPO_API_URL) return process.env.KEYQ_TEMPO_API_URL;
  try { return readFileSync(URL_PATH, 'utf8').trim() || DEFAULT_API_URL; } catch { return DEFAULT_API_URL; }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function extractAssistantText(entry: TranscriptEntry): string | null {
  // Normalize the entry's content/role across schema variants.
  const role = entry.message?.role ?? entry.role;
  if (role !== 'assistant') return null;
  const content = entry.message?.content ?? entry.content;
  if (typeof content === 'string') return content || null;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  const joined = parts.join('\n\n').trim();
  return joined || null;
}

function extractInputTokens(entry: TranscriptEntry): number | null {
  // input_tokens in the API response = the prompt size for that turn,
  // which is effectively the current context size after that turn lands.
  const usage = entry.message?.usage ?? entry.usage;
  if (!usage || typeof usage.input_tokens !== 'number') return null;
  // Cache hits are still part of context size, so include them.
  const cacheRead = entry.message?.usage?.cache_read_input_tokens ?? 0;
  const cacheCreate = entry.message?.usage?.cache_creation_input_tokens ?? 0;
  return usage.input_tokens + (typeof cacheRead === 'number' ? cacheRead : 0) + (typeof cacheCreate === 'number' ? cacheCreate : 0);
}

function findLatestAssistantTurn(transcriptPath: string): { text: string; inputTokens: number | null } | null {
  let raw: string;
  try { raw = readFileSync(transcriptPath, 'utf8'); }
  catch { return null; }
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  // Walk backwards — most recent assistant message wins.
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]) as TranscriptEntry;
      const text = extractAssistantText(entry);
      if (text) return { text, inputTokens: extractInputTokens(entry) };
    } catch { /* skip malformed lines */ }
  }
  return null;
}

function deliverBlock(content: string): never {
  // Stop hook continuation: returning decision:"block" + reason tells
  // Claude Code NOT to stop and to treat reason as the next prompt.
  // Note: hookSpecificOutput is only valid for PreToolUse /
  // UserPromptSubmit / PostToolUse / PostToolBatch, NOT Stop — so we
  // do not include it here.
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: `(via Tempo) ${content}`,
  }));
  process.exit(0);
}

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

async function main() {
  // Whatever happens, exit 0 with empty output so Claude Code stops normally.
  // We are a passive observer; mirror failures must never block the user.
  let input: HookInput;
  try {
    const raw = await readStdin();
    input = raw.trim() ? (JSON.parse(raw) as HookInput) : {};
  } catch {
    process.exit(0);
  }

  const transcriptPath = input.transcript_path;
  if (!transcriptPath) process.exit(0);

  const token = readToken();
  if (!token) process.exit(0); // not enrolled — silently skip

  const apiUrl = getApiUrl();
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  // Find the Tempo session for this device. Same lookup as the permission
  // hook — prefer cwd match, fall back to most recent.
  let sessionId: number | null = null;
  try {
    const r = await fetch(`${apiUrl}/mcp/device-sessions`, { headers });
    if (r.ok) {
      const sessions = await r.json() as { id: number; cwd: string | null }[];
      const match = input.cwd ? sessions.find((s) => s.cwd === input.cwd) : null;
      sessionId = (match || sessions[0])?.id ?? null;
    }
  } catch { /* fall through */ }

  if (!sessionId) process.exit(0);

  // Short-running calls (mirror + consume) get a 15s timeout; the long
  // wait endpoint gets its own larger timeout in the listen loop below.
  const SHORT_FETCH_TIMEOUT_MS = 15_000;

  // 1) Mirror the latest assistant turn to Tempo. Runs on EVERY Stop
  //    event, including continuations where stop_hook_active=true. Each
  //    such Stop corresponds to a distinct new assistant turn (Claude's
  //    response to whatever was injected via the previous block), so
  //    mirroring is non-duplicative — and skipping it would silently lose
  //    every continuation turn from the web timeline.
  const turn = findLatestAssistantTurn(transcriptPath);
  if (turn) {
    try {
      const body: Record<string, unknown> = { role: 'assistant', content: turn.text };
      if (turn.inputTokens !== null) body.input_tokens = turn.inputTokens;
      await fetch(`${apiUrl}/mcp/sessions/${sessionId}/messages`, {
        method: 'POST', headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SHORT_FETCH_TIMEOUT_MS),
      });
    } catch { /* swallow */ }
  }

  // 2) Drain any messages queued during this turn so the next Claude
  //    response includes them as user input. Also runs on every Stop —
  //    if a Tempo prompt arrived between two continuations, we want to
  //    deliver it on the next Stop without waiting for the wait
  //    endpoint's first poll cycle.
  try {
    const r = await fetch(`${apiUrl}/mcp/sessions/${sessionId}/inbox/consume`, {
      method: 'POST', headers, body: JSON.stringify({}),
      signal: AbortSignal.timeout(SHORT_FETCH_TIMEOUT_MS),
    });
    if (r.ok) {
      const data = await r.json() as { content: string | null };
      if (data.content && data.content.trim()) deliverBlock(data.content);
    }
  } catch { /* swallow */ }

  // 2) Listening loop. The wait endpoint handles the listening_mode policy:
  //    if listening is off it returns immediately with listening_canceled
  //    and we exit normally. If on, it long-polls server-side (~25s) for
  //    new inbox entries; we reconnect after each timeout for an unbounded
  //    effective wait. Network errors back off and retry — the user's
  //    workstation may have flaky connectivity but we want to keep listening.
  //
  //    Defensive: every fetch has an AbortSignal timeout so a half-open TCP
  //    connection (sleeping laptop, dropped CF edge) can't hang indefinitely.
  //    JSON parse is wrapped in try/catch so a malformed response doesn't
  //    crash the hook — without this, an exception here would propagate
  //    out of main() and the outer .catch(() => exit(0)) would silently end
  //    the listening session.
  let backoff = 5_000;
  const MAX_BACKOFF = 60_000;
  // Wait endpoint blocks ~25s server-side; 35s aborts give ~10s headroom.
  const FETCH_TIMEOUT_MS = 35_000;
  for (;;) {
    let resp: Response;
    try {
      resp = await fetch(`${apiUrl}/mcp/sessions/${sessionId}/inbox/wait`, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      // Network error or timeout — backoff and retry.
      await sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
      continue;
    }

    // 4xx without retry — session terminated externally, or auth invalidated.
    // Either way, stop listening.
    if (resp.status === 404 || resp.status === 410 || resp.status === 401 || resp.status === 403) {
      process.exit(0);
    }
    // Other non-OK: backoff and retry.
    if (!resp.ok) {
      await sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
      continue;
    }
    backoff = 5_000; // reset on any successful response

    let data: { content: string | null; listening_canceled?: boolean };
    try {
      data = await resp.json() as typeof data;
    } catch {
      // Malformed/truncated response. Treat as transient and retry —
      // do NOT let the exception kill the hook.
      await sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
      continue;
    }

    if (data.content && data.content.trim()) deliverBlock(data.content);

    // User toggled listening off (or it was off to begin with). Exit
    // normally so Claude stops.
    if (data.listening_canceled) process.exit(0);

    // Empty timeout — server closed at the wait window with nothing
    // queued. Reconnect immediately for the next window.
  }
}

main().catch(() => process.exit(0));
