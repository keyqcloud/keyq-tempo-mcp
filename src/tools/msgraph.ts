// Microsoft 365 tools — the signed-in operator's own Outlook calendar and
// mailbox, via the API's on-demand Graph routes (/me/calendar/*, /me/mail/*).
// The device token identifies the user; the API uses that user's stored
// delegated MS tokens. Requires the operator to have connected their Microsoft
// account (Settings → Calendar) with mail scopes granted. Distinct from the AI
// email-assistant flow (which is triggered by inbound email).

import { api } from '../api.js';

interface CalendarEvent {
  id: string; subject: string; start: string | null; end: string | null;
  timezone: string; is_all_day: boolean; location: string | null;
  join_url: string | null; web_link: string | null; organizer: string | null;
  attendees: string[]; preview: string;
}

interface MailSummary {
  id: string; subject: string; from: string | null; from_name: string | null;
  to: string[]; received_at: string | null; preview: string;
  is_read: boolean; has_attachments: boolean; web_link: string | null;
}

interface MailFull extends MailSummary {
  cc: string[]; body: string; body_content_type: string;
}

const fmtDt = (iso: string | null) => (iso ? iso.replace('T', ' ').replace(/:\d{2}(\.\d+)?(Z)?$/, '') : '?');

export async function listCalendarEvents(opts: { start?: string; end?: string; top?: number }): Promise<string> {
  const qs = new URLSearchParams();
  if (opts.start) qs.set('start', opts.start);
  if (opts.end) qs.set('end', opts.end);
  if (opts.top) qs.set('top', String(opts.top));
  const url = '/me/calendar/events' + (qs.toString() ? `?${qs}` : '');
  const events = await api.get<CalendarEvent[]>(url);
  if (events.length === 0) return 'No events in that window.';
  return events.map((e) => {
    const when = e.is_all_day ? `${fmtDt(e.start)} (all day)` : `${fmtDt(e.start)} → ${fmtDt(e.end)} ${e.timezone}`;
    const extras = [
      e.location ? `@ ${e.location}` : '',
      e.join_url ? `join: ${e.join_url}` : '',
      e.attendees.length ? `with: ${e.attendees.join(', ')}` : '',
    ].filter(Boolean).join(' | ');
    return `• ${when} — ${e.subject}${extras ? `\n    ${extras}` : ''}\n    id: ${e.id}`;
  }).join('\n');
}

export async function createCalendarEvent(opts: {
  title: string; start_iso: string; end_iso?: string; duration_minutes?: number;
  attendees?: string[]; optional_attendees?: string[]; body?: string;
  online_provider?: 'teams' | 'external' | 'none'; external_link?: string;
}): Promise<string> {
  const res = await api.post<{ ok: boolean; id: string; web_link: string | null; join_url: string | null }>(
    '/me/calendar/events', opts,
  );
  const lines = [`Created event: ${opts.title}`, `id: ${res.id}`];
  if (res.web_link) lines.push(`link: ${res.web_link}`);
  if (res.join_url) lines.push(`join: ${res.join_url}`);
  return lines.join('\n');
}

export async function listEmails(opts: { top?: number; search?: string; folder?: string }): Promise<string> {
  const qs = new URLSearchParams();
  if (opts.top) qs.set('top', String(opts.top));
  if (opts.search) qs.set('search', opts.search);
  if (opts.folder) qs.set('folder', opts.folder);
  const url = '/me/mail/messages' + (qs.toString() ? `?${qs}` : '');
  const msgs = await api.get<MailSummary[]>(url);
  if (msgs.length === 0) return 'No messages.';
  return msgs.map((m) => {
    const flags = [m.is_read ? '' : '● UNREAD', m.has_attachments ? '📎' : ''].filter(Boolean).join(' ');
    return `• ${fmtDt(m.received_at)} — ${m.from_name || m.from || '?'} ${flags}\n`
      + `    ${m.subject}\n`
      + `    ${m.preview.slice(0, 120)}\n`
      + `    id: ${m.id}`;
  }).join('\n');
}

export async function readEmail(opts: { id: string }): Promise<string> {
  const m = await api.get<MailFull>(`/me/mail/messages/${encodeURIComponent(opts.id)}`);
  const lines = [
    `From: ${m.from_name ? `${m.from_name} <${m.from}>` : m.from}`,
    `To: ${m.to.join(', ')}`,
    m.cc.length ? `Cc: ${m.cc.join(', ')}` : '',
    `Date: ${fmtDt(m.received_at)}`,
    `Subject: ${m.subject}`,
    m.has_attachments ? '(has attachments)' : '',
    '',
    m.body,
  ].filter((l) => l !== '');
  return lines.join('\n');
}

export async function draftEmail(opts: { to: string[]; subject?: string; body?: string; cc?: string[]; html?: boolean }): Promise<string> {
  const res = await api.post<{ ok: boolean; id: string; web_link: string | null }>('/me/mail/drafts', opts);
  return `Draft created (id: ${res.id}).${res.web_link ? `\nOpen in Outlook: ${res.web_link}` : ''}\n`
    + 'Review it, then send with tempo_send_email using draft_id — or edit it in Outlook first.';
}

export async function sendEmail(opts: {
  draft_id?: string; to?: string[]; subject?: string; body?: string; cc?: string[]; html?: boolean;
}): Promise<string> {
  const res = await api.post<{ ok: boolean; sent_draft?: string }>('/me/mail/send', opts);
  if (res.sent_draft) return `Sent draft ${res.sent_draft}.`;
  return `Email sent to ${(opts.to || []).join(', ')}.`;
}
