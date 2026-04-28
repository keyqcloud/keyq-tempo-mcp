// Claude Code PreToolUse hook that forwards tool permission prompts to KeyQ
// Tempo. Reads the hook input JSON from stdin, looks up the device's active
// Tempo session, creates a permission prompt, blocks until the user
// allows/denies via the web UI (or until 30-min timeout / network failure,
// both of which fail-deny). Writes the Claude Code hook response JSON to
// stdout.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.keyq-tempo');
const TOKEN_PATH = join(CONFIG_DIR, 'token');
const URL_PATH = join(CONFIG_DIR, 'api-url');

const DEFAULT_API_URL = 'https://tempo-api.keyq.io';
const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const POLL_WAIT_SECS = 30;

interface HookInput {
  session_id?: string;
  cwd?: string;
  tool_name: string;
  tool_input: unknown;
}

function readToken(): string | null {
  try { return readFileSync(TOKEN_PATH, 'utf8').trim() || null; } catch { return null; }
}

function getApiUrl(): string {
  if (process.env.KEYQ_TEMPO_API_URL) return process.env.KEYQ_TEMPO_API_URL;
  try { return readFileSync(URL_PATH, 'utf8').trim() || DEFAULT_API_URL; } catch { return DEFAULT_API_URL; }
}

function emitDecision(decision: 'allow' | 'deny', reason: string): never {
  // Output both legacy and modern Claude Code hook formats. Whichever the
  // installed Claude Code version recognizes will be honored.
  const out = {
    continue: decision === 'allow',
    decision: decision === 'allow' ? 'approve' : 'block',
    reason,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision === 'allow' ? 'allow' : 'deny',
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let input: HookInput;
  try {
    const raw = await readStdin();
    input = JSON.parse(raw);
  } catch (e) {
    emitDecision('deny', `keyq-tempo-permission-hook: invalid hook input: ${e instanceof Error ? e.message : 'unknown'}`);
  }

  const token = readToken();
  if (!token) {
    emitDecision('deny', 'keyq-tempo-permission-hook: not enrolled. Run: npx -y github:keyqcloud/keyq-tempo-mcp enroll <code>');
  }

  const apiUrl = getApiUrl();
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  // Find a session for this device. Prefer matching cwd; fall back to most recent.
  let sessionId: number | null = null;
  try {
    const r = await fetch(`${apiUrl}/mcp/device-sessions`, { headers });
    if (r.ok) {
      const sessions = await r.json() as { id: number; cwd: string | null }[];
      const match = input.cwd ? sessions.find((s) => s.cwd === input.cwd) : null;
      sessionId = (match || sessions[0])?.id ?? null;
    }
  } catch { /* fall through to deny */ }

  if (!sessionId) {
    emitDecision('deny', 'keyq-tempo-permission-hook: no active Claude Code session registered with Tempo');
  }

  // Build human-readable prompt text.
  const argSummary = (() => {
    try { return JSON.stringify(input.tool_input, null, 2); }
    catch { return String(input.tool_input); }
  })();
  const promptText = `Claude wants to run ${input.tool_name}\n\n${argSummary}`;

  // Create the prompt.
  let promptId: number;
  try {
    const create = await fetch(`${apiUrl}/mcp/questions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        session_id: sessionId,
        type: 'permission',
        question: promptText,
        tool_metadata: { tool_name: input.tool_name, tool_input: input.tool_input },
      }),
    });
    if (!create.ok) {
      emitDecision('deny', `keyq-tempo-permission-hook: prompt create failed (${create.status})`);
    }
    const data = await create.json() as { id: number };
    promptId = data.id;
  } catch (e) {
    emitDecision('deny', `keyq-tempo-permission-hook: network error creating prompt: ${e instanceof Error ? e.message : 'unknown'}`);
  }

  // Long-poll for decision.
  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    try {
      const r = await fetch(`${apiUrl}/mcp/questions/${promptId}?wait=${POLL_WAIT_SECS}`, { headers });
      if (!r.ok) {
        emitDecision('deny', `keyq-tempo-permission-hook: poll failed (${r.status})`);
      }
      const data = await r.json() as { status: string; response: string | null };
      if (data.status === 'answered') {
        const dec = data.response?.trim().toLowerCase() === 'allow' ? 'allow' : 'deny';
        const reason = dec === 'allow'
          ? 'Approved via Tempo'
          : `Denied via Tempo${data.response && data.response.toLowerCase() !== 'deny' ? ': ' + data.response : ''}`;
        emitDecision(dec, reason);
      }
      if (data.status === 'canceled') emitDecision('deny', 'User canceled the prompt');
      if (data.status === 'expired') emitDecision('deny', 'Prompt expired');
      // Still pending — loop back to poll again.
    } catch (e) {
      emitDecision('deny', `keyq-tempo-permission-hook: poll error: ${e instanceof Error ? e.message : 'unknown'}`);
    }
  }

  emitDecision('deny', 'Timed out waiting for Tempo approval (30 min)');
}

main().catch((err) => {
  emitDecision('deny', `keyq-tempo-permission-hook: fatal: ${err instanceof Error ? err.message : 'unknown'}`);
});
