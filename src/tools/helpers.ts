// Read-only helpers that are useful during scrum sessions and while working
// cards. Trimmed down from the bridge-mvp data.ts to just what sprint mode
// reaches for: Fathom meetings (action-item context for cards) + attachment
// reading (PDFs / docs attached to cards).

import { api } from '../api.js';

interface Meeting {
  id: number; title: string; summary: string | null; meeting_date: string;
  duration: number; recording_url: string | null; invitees: string; action_items: string;
  customer_id: number | null; customer_name?: string | null;
}

const MAX_INLINE_BYTES = 64 * 1024;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function isTextish(contentType: string | null): boolean {
  if (!contentType) return false;
  return /^text\//i.test(contentType)
    || /\bjson\b/i.test(contentType)
    || /\bxml\b/i.test(contentType)
    || /\bjavascript\b/i.test(contentType)
    || /\bcsv\b/i.test(contentType);
}

export async function listMeetings(opts: { customer_id?: number; limit?: number }): Promise<string> {
  const params: string[] = [];
  if (opts.customer_id) params.push(`customer_id=${opts.customer_id}`);
  const url = '/fathom/meetings' + (params.length ? '?' + params.join('&') : '');
  const rows = await api.get<Meeting[]>(url);
  const limit = opts.limit ?? 20;
  if (rows.length === 0) return 'No meetings.';
  return rows.slice(0, limit).map((m) => {
    const mins = Math.round((m.duration || 0) / 60);
    return `#${m.id} ${m.meeting_date.slice(0, 10)} (${mins}m) — ${m.title}` +
      `${m.customer_name ? ` — ${m.customer_name}` : ''}`;
  }).join('\n');
}

export async function getMeeting(opts: { id: number }): Promise<string> {
  const rows = await api.get<Meeting[]>('/fathom/meetings');
  const m = rows.find((x) => x.id === opts.id);
  if (!m) return `Meeting #${opts.id} not found.`;
  const invitees = (() => { try { return JSON.parse(m.invitees) as { name?: string; email: string }[]; } catch { return []; } })();
  const actions = (() => { try { return JSON.parse(m.action_items) as { description: string; assignee?: string; completed: boolean }[]; } catch { return []; } })();
  const lines = [
    `# Meeting #${m.id}: ${m.title}`,
    `Date: ${m.meeting_date} | Duration: ${Math.round((m.duration || 0) / 60)}m`,
    m.customer_name ? `Customer: ${m.customer_name}` : '',
    m.recording_url ? `Recording: ${m.recording_url}` : '',
  ].filter(Boolean);
  if (invitees.length) lines.push('', `Attendees: ${invitees.map((i) => i.name || i.email).join(', ')}`);
  if (m.summary) lines.push('', '## Summary', m.summary);
  if (actions.length) {
    lines.push('', '## Action items');
    for (const a of actions) {
      const mark = a.completed ? '[x]' : '[ ]';
      lines.push(`${mark} ${a.description}${a.assignee ? ` (${a.assignee})` : ''}`);
    }
  }
  return lines.join('\n');
}

export async function readAttachment(opts: { id: number }): Promise<string> {
  const res = await api.fetchRaw(`/attachments/${opts.id}/download`);
  const contentType = res.headers.get('content-type');
  const sizeHeader = res.headers.get('content-length');
  if (!isTextish(contentType)) {
    return `Attachment #${opts.id} is binary (${contentType || 'unknown'}, ${sizeHeader ? fmtBytes(Number(sizeHeader)) : 'unknown size'}). Cannot inline.`;
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_INLINE_BYTES) {
    const head = new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, MAX_INLINE_BYTES));
    return `[file truncated to first ${fmtBytes(MAX_INLINE_BYTES)} of ${fmtBytes(buf.byteLength)}]\n\n${head}`;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}
