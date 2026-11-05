// Read-only helpers that are useful during scrum sessions and while working
// cards. Trimmed down from the bridge-mvp data.ts to just what sprint mode
// reaches for: recorded meetings (action-item context for cards) + attachment
// reading (PDFs / docs attached to cards).

import { api, ApiError } from '../api.js';

// The in-house recorder's shape (GET /meetings).
interface Meeting {
  id: number; source: string; title: string | null; summary: string | null;
  meeting_date: string; scheduled_start: string | null; duration: number | null;
  status: string; processing_level: string; action_items: string | null;
  customer_id: number | null; customer_name?: string | null;
  has_transcript?: number; purged_at?: string | null;
}

// The detail endpoint leaves the transcript out for a device token: it is read through
// getMeetingTranscript, which applies the AI posture rule and audits the read.
interface MeetingDetail extends Meeting {
  participants: string | null;
}

interface MeetingTranscript {
  meeting_id: number; title: string | null; offset: number;
  total_chars: number; next_offset: number | null; transcript: string;
}

interface TeamMember { id: number; initials: string; name: string }

interface Project {
  id: number; code: string | null; name: string;
  customer_id: number | null; archived_at?: string | null;
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

// Team members are referenced by id when assigning cards. The default
// sprint assignee is the "Claude Code" team_member (initials=CC). This
// returns the full list so the skill can resolve names ↔ ids without
// asking the operator.
export async function listTeamMembers(): Promise<string> {
  const rows = await api.get<TeamMember[]>('/team-members');
  if (rows.length === 0) return 'No team members.';
  const headerLine = 'id  initials  name';
  const rowLines = rows.map((m) => `${String(m.id).padEnd(3)}  ${m.initials.padEnd(8)}  ${m.name}`);
  return [headerLine, ...rowLines].join('\n');
}

// Projects are boards: one project = one board (its project_id is what every
// other sprint tool needs). This resolves a project_code (e.g. "TEMPO") or
// name to its id without the operator having to look it up. Skips archived
// projects unless include_archived is set.
export async function listProjects(opts: { include_archived?: boolean; query?: string; customer_id?: number } = {}): Promise<string> {
  const url = '/projects' + (opts.customer_id ? `?customer_id=${opts.customer_id}` : '');
  const rows = await api.get<Project[]>(url);
  let visible = opts.include_archived ? rows : rows.filter((p) => !p.archived_at);
  if (opts.query) {
    const q = opts.query.toLowerCase();
    visible = visible.filter((p) => (p.code ?? '').toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
  }
  if (visible.length === 0) return opts.query ? `No projects matching "${opts.query}".` : 'No projects.';
  // Boards are 1:1 with a customer; resolve names so each row shows its owner
  // (best-effort — fall back to the id if the customers read is unavailable).
  const custName = new Map<number, string>();
  try {
    const customers = await api.get<{ id: number; name: string }[]>('/customers');
    for (const c of customers) custName.set(c.id, c.name);
  } catch { /* owner names are optional decoration */ }
  const headerLine = 'id   code        name';
  const rowLines = visible.map((p) => {
    const owner = p.customer_id != null ? (custName.get(p.customer_id) ?? `customer #${p.customer_id}`) : '';
    return `${String(p.id).padEnd(4)} ${String(p.code ?? '').padEnd(11)} ${p.name}` +
      `${owner ? ` — ${owner}` : ''}${p.archived_at ? ' (archived)' : ''}`;
  });
  return [headerLine, ...rowLines].join('\n');
}

export async function listMeetings(opts: { customer_id?: number; limit?: number }): Promise<string> {
  const params: string[] = [];
  if (opts.customer_id) params.push(`customer_id=${opts.customer_id}`);
  const url = '/meetings' + (params.length ? '?' + params.join('&') : '');
  const rows = await api.get<Meeting[]>(url);
  const limit = opts.limit ?? 20;
  if (rows.length === 0) return 'No meetings.';
  return rows.slice(0, limit).map((m) => {
    const mins = Math.round((m.duration || 0) / 60);
    const when = (m.scheduled_start || m.meeting_date).slice(0, 10);
    // Untitled is common — Google Meet supplies no title — so fall back to
    // something that distinguishes one row from another.
    const titled = !!m.title?.trim();
    const label = titled ? m.title : `${m.customer_name || 'Untitled'} (${when})`;
    const flags = [
      m.purged_at ? 'purged' : null,
      m.status !== 'ready' ? m.status : null,
      m.source === 'upload' ? 'in-person' : null,
    ].filter(Boolean).join(', ');
    return `#${m.id} ${when} (${mins}m) — ${label}` +
      `${m.customer_name && titled ? ` — ${m.customer_name}` : ''}` +
      `${flags ? ` [${flags}]` : ''}`;
  }).join('\n');
}

export async function getMeeting(opts: { id: number }): Promise<string> {
  let m: MeetingDetail;
  try {
    m = await api.get<MeetingDetail>(`/meetings/${opts.id}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return `Meeting #${opts.id} not found.`;
    throw e;
  }
  if (m.purged_at) {
    return `Meeting #${m.id} was purged on ${m.purged_at.slice(0, 10)}. `
      + `Its recording, transcript and derived summary were destroyed; only the tombstone remains.`;
  }

  const attendees = (() => {
    try { return (JSON.parse(m.participants || '[]') as { name?: string }[]).map((p) => p.name).filter(Boolean); }
    catch { return [] as (string | undefined)[]; }
  })();
  const actions = (() => {
    try { return JSON.parse(m.action_items || '[]') as { description: string; assignee?: string | null }[]; }
    catch { return []; }
  })();

  const when = m.scheduled_start || m.meeting_date;
  const lines = [
    `# Meeting #${m.id}: ${m.title?.trim() || '(untitled)'}`,
    `Date: ${when} | Duration: ${Math.round((m.duration || 0) / 60)}m | Source: ${m.source}`,
    m.customer_name ? `Customer: ${m.customer_name}` : 'Customer: (unmapped)',
    m.status !== 'ready' ? `Status: ${m.status}` : '',
    // Says why there is no summary, rather than leaving a reader to assume the
    // meeting was empty. 'record'/'transcribe' are deliberate consent settings.
    m.processing_level !== 'full' ? `Processing level: ${m.processing_level} (no AI summary by design)` : '',
  ].filter(Boolean);

  if (attendees.length) lines.push('', `Attendees: ${attendees.join(', ')}`);
  if (m.summary) lines.push('', '## Summary', m.summary);
  if (actions.length) {
    lines.push('', '## Action items');
    for (const a of actions) lines.push(`- ${a.description}${a.assignee ? ` (${a.assignee})` : ''}`);
  }
  if (!m.summary && m.has_transcript) lines.push('', '_Transcript exists but no summary was generated._');
  if (m.has_transcript) lines.push('', `_A transcript exists. Read it with tempo_get_meeting_transcript (id ${m.id}) if the summary is not enough._`);
  return lines.join('\n');
}

export async function getMeetingTranscript(opts: { id: number; offset?: number; max_chars?: number }): Promise<string> {
  const q = new URLSearchParams();
  if (opts.offset) q.set('offset', String(opts.offset));
  if (opts.max_chars) q.set('max_chars', String(opts.max_chars));
  const query = q.size ? `?${q}` : '';
  let t: MeetingTranscript;
  try {
    t = await api.get<MeetingTranscript>(`/meetings/${opts.id}/transcript${query}`);
  } catch (e) {
    // These are answers, not failures: the reason is the useful part, and it must not read
    // as something to retry or work around.
    if (e instanceof ApiError && [403, 404, 410].includes(e.status)) return `Meeting #${opts.id}: ${e.message}`;
    throw e;
  }
  const shown = t.offset + t.transcript.length;
  const lines = [
    `# Transcript of meeting #${t.meeting_id}: ${t.title?.trim() || '(untitled)'}`,
    `Characters ${t.offset}-${shown} of ${t.total_chars}`,
    '',
    t.transcript,
  ];
  if (t.next_offset != null) lines.push('', `_More follows. Call again with offset ${t.next_offset}._`);
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
