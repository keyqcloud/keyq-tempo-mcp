// Claude Code Stop hook that mirrors each assistant turn to KeyQ Tempo.
// Reads the hook input JSON from stdin, locates the latest assistant turn
// in the transcript, extracts text blocks, POSTs to Tempo. Exits 0 with no
// output so Claude stops normally — this is a passive observer, never a
// blocker.
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

  // Stop hook recursion guard — if the hook is being invoked because of a
  // previous hook continuation, just exit so we don't double-mirror.
  if (input.stop_hook_active) process.exit(0);

  const transcriptPath = input.transcript_path;
  if (!transcriptPath) process.exit(0);

  const text = findLatestAssistantText(transcriptPath);
  if (!text) process.exit(0);

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

  // 1) Mirror the assistant turn to Tempo (best-effort).
  try {
    await fetch(`${apiUrl}/mcp/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ role: 'assistant', content: text }),
    });
  } catch { /* swallow */ }

  // 2) Consume any pending inbox messages for this session. If there are
  //    queued user prompts (sent from Tempo web while we were mid-turn),
  //    deliver them now by returning decision:"block" so Claude continues
  //    with that content as the next prompt.
  try {
    const r = await fetch(`${apiUrl}/mcp/sessions/${sessionId}/inbox/consume`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });
    if (r.ok) {
      const data = await r.json() as { content: string | null };
      if (data.content && data.content.trim()) {
        // Output the Stop hook block decision and exit 0 so Claude Code
        // continues with this content. Output formats are dual-printed for
        // legacy + modern hook conventions.
        const out = {
          decision: 'block',
          reason: `(via Tempo) ${data.content}`,
          continue: true,
          hookSpecificOutput: {
            hookEventName: 'Stop',
            additionalContext: data.content,
          },
        };
        process.stdout.write(JSON.stringify(out));
        process.exit(0);
      }
    }
  } catch { /* swallow */ }

  process.exit(0);
}

main().catch(() => process.exit(0));
