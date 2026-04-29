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
  };
  // Older variants may put role/content at the top level.
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
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

function findLatestAssistantText(transcriptPath: string): string | null {
  let raw: string;
  try { raw = readFileSync(transcriptPath, 'utf8'); }
  catch { return null; }
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  // Walk backwards — most recent assistant message wins.
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]) as TranscriptEntry;
      const text = extractAssistantText(entry);
      if (text) return text;
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

  // 1) Mirror + immediate consume — only on the FIRST Stop of a turn.
  //    When stop_hook_active=true, the current Stop is itself a continuation
  //    triggered by a previous decision:"block" (i.e., we're inside a
  //    listening loop). In that case we skip mirror to avoid double-
  //    mirroring the same turn, but still enter the listening loop below.
  if (!input.stop_hook_active) {
    const text = findLatestAssistantText(transcriptPath);
    if (text) {
      try {
        await fetch(`${apiUrl}/mcp/sessions/${sessionId}/messages`, {
          method: 'POST', headers, body: JSON.stringify({ role: 'assistant', content: text }),
        });
      } catch { /* swallow */ }
    }

    // Drain any messages queued during this turn so the next Claude
    // response includes them as user input.
    try {
      const r = await fetch(`${apiUrl}/mcp/sessions/${sessionId}/inbox/consume`, {
        method: 'POST', headers, body: JSON.stringify({}),
      });
      if (r.ok) {
        const data = await r.json() as { content: string | null };
        if (data.content && data.content.trim()) deliverBlock(data.content);
      }
    } catch { /* swallow */ }
  }

  // 2) Listening loop. The wait endpoint handles the listening_mode policy:
  //    if listening is off it returns immediately with listening_canceled
  //    and we exit normally. If on, it long-polls server-side (~25s) for
  //    new inbox entries; we reconnect after each timeout for an unbounded
  //    effective wait. Network errors back off and retry — the user's
  //    workstation may have flaky connectivity but we want to keep listening.
  let backoff = 5_000;
  const MAX_BACKOFF = 60_000;
  for (;;) {
    let resp: Response;
    try {
      resp = await fetch(`${apiUrl}/mcp/sessions/${sessionId}/inbox/wait`, { headers });
    } catch {
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

    const data = await resp.json() as {
      content: string | null;
      listening_canceled?: boolean;
    };

    if (data.content && data.content.trim()) deliverBlock(data.content);

    // User toggled listening off (or it was off to begin with). Exit
    // normally so Claude stops.
    if (data.listening_canceled) process.exit(0);

    // Empty timeout — server closed at the wait window with nothing
    // queued. Reconnect immediately for the next window.
  }
}

main().catch(() => process.exit(0));
