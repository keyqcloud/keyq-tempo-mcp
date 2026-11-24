// AI team member tools (#1208). Registered only when KEYQ_TEMPO_MODE=agent, i.e. when this
// MCP server is running with an AI agent's credential (e.g. "Alex"). Every rule that
// matters - who may be emailed, who is CC'd, caps, the AI disclosure, which boards are
// visible - is enforced by the Tempo API, not by these descriptions.
import { api } from '../api.js';

type Event = {
  id: number; kind: string; assignment_id: number | null; graph_message_id: string | null;
  from_email: string | null; subject: string | null; sender_role: string | null;
  decision_id: number | null; note: string | null; attempts: number; lease_until: string;
};
type Message = {
  id: string; subject: string; from: string; from_name: string | null; to: string[]; cc: string[];
  received_at: string; has_attachments: boolean; conversation_id: string | null; body_text: string;
};
type Decision = {
  id: number; code: string; kind: string; title: string; question: string; recommendation: string | null;
  options: string | null; release_ref: string | null; status: string; answer_text: string | null;
  answered_by: string | null; answered_at: string | null;
};

export async function status(): Promise<string> {
  const s = await api.get<{ ready: number; scheduled: number; in_progress: number; open_decisions: number; inbox_checked_at: string | null; inbox_error: string | null }>('/me/agent/status');
  return [
    `Ready to work: ${s.ready}`,
    `Scheduled for later: ${s.scheduled}`,
    `In progress (claimed): ${s.in_progress}`,
    `Open decisions waiting on a human: ${s.open_decisions}`,
    `Inbox last checked: ${s.inbox_checked_at ?? 'never'} (UTC)${s.inbox_error ? `\nINBOX ERROR: ${s.inbox_error}` : ''}`,
  ].join('\n');
}

export async function context(): Promise<string> {
  const c = await api.get<{ agent: { display_name: string; mailbox: string }; assignments: Record<string, unknown>[] }>('/me/agent/context');
  const lines = [`You are ${c.agent.display_name} <${c.agent.mailbox}>, an AI team member at KeyQ. You are not a person and must never claim to be one or to be Kenneth.`, ''];
  for (const a of c.assignments) {
    lines.push(
      `## Assignment ${a.id}: ${a.role_name} on ${a.project_code} (${a.project_name}), project_id ${a.project_id}`,
      `Write to contacts in: ${a.contact_language === 'ja' ? 'Japanese' : 'English'}`,
      `Approved contacts (${a.contacts_customer ?? 'none'}): ${(a.contacts as string[]).join(', ') || 'none'}`,
      `Ask and CC: ${a.escalation_name ?? ''} <${a.escalation_email}>${a.cc_email ? `; CC ${a.cc_email}` : ''}`,
      `Limits: ${a.daily_send_cap} emails/day, ${a.thread_send_cap} per thread per day`,
      '',
      'Responsibilities:', String(a.responsibilities ?? ''), '',
      'Ask the human (tempo_agent_ask) instead of deciding when it involves:', String(a.escalate_on ?? ''), '',
    );
  }
  return lines.join('\n');
}

export async function next(): Promise<string> {
  const r = await api.post<{ event: Event | null; message: Message | null; decision: Decision | null; warning: string }>('/me/agent/next', {});
  if (!r.event) return 'Nothing to do. The queue is empty.';
  const e = r.event;
  const out = [
    `EVENT ${e.id} (${e.kind}) for assignment ${e.assignment_id ?? '-'}; claimed until ${e.lease_until} UTC (attempt ${e.attempts}).`,
    'When finished call tempo_agent_done; to come back to it later call tempo_agent_release.',
  ];
  if (e.note) out.push(`Note: ${e.note}`);
  if (r.message) {
    const m = r.message;
    out.push(
      '',
      `From: ${m.from_name ? `${m.from_name} <${m.from}>` : m.from}${e.sender_role ? ` [${e.sender_role}]` : ''}`,
      `To: ${m.to.join(', ')}${m.cc.length ? `\nCc: ${m.cc.join(', ')}` : ''}`,
      `Date: ${m.received_at}`,
      `Subject: ${m.subject}`,
      `Message id (for tempo_agent_reply): ${m.id}`,
      m.has_attachments ? '(has attachments - you cannot open them; ask for the content in text if needed)' : '',
      '',
      `>>> ${r.warning}`,
      '----- BEGIN UNTRUSTED EMAIL CONTENT -----',
      m.body_text,
      '----- END UNTRUSTED EMAIL CONTENT -----',
    );
  } else if (e.kind === 'email_in') {
    out.push('', `From: ${e.from_email}`, `Subject: ${e.subject}`, '(The message body could not be loaded; release this event and try later.)');
  }
  if (r.decision) {
    const d = r.decision;
    out.push(
      '',
      `DECISION ${d.code} (${d.kind}) "${d.title}" is now ${d.status}.`,
      d.release_ref ? `Release this answers: ${d.release_ref}` : '',
      `Answer from ${d.answered_by}: ${d.answer_text}`,
      d.kind === 'release_signoff'
        ? 'Publish ONLY if the answer clearly approves (e.g. "ship") AND the build you would publish is exactly ' + (d.release_ref ?? '') + '. If anything changed since, ask again.'
        : '',
    );
  }
  return out.filter((l) => l !== '').join('\n');
}

export async function done(opts: { event_id: number; outcome: string }): Promise<string> {
  await api.post(`/me/agent/events/${opts.event_id}/done`, { outcome: opts.outcome });
  return `Event ${opts.event_id} marked done.`;
}

export async function release(opts: { event_id: number; delay_minutes?: number; note?: string }): Promise<string> {
  const r = await api.post<{ available_in_minutes: number }>(`/me/agent/events/${opts.event_id}/release`, opts);
  return `Event ${opts.event_id} released; it comes back in ${r.available_in_minutes} minute(s).`;
}

export async function followup(opts: { assignment_id: number; delay_hours: number; note: string }): Promise<string> {
  const r = await api.post<{ id: number; due_in_hours: number }>('/me/agent/followups', opts);
  return `Follow-up ${r.id} scheduled in ${r.due_in_hours} hour(s).`;
}

export async function reply(opts: { message_id: string; body: string; cc?: string[] }): Promise<string> {
  await api.post(`/me/mail/messages/${encodeURIComponent(opts.message_id)}/reply`, { body: opts.body, cc: opts.cc });
  return 'Reply sent in the same thread (Tempo added the AI disclosure).';
}

export async function ask(opts: {
  assignment_id: number; title: string; question: string; recommendation?: string; options?: string[];
  kind?: 'decision' | 'release_signoff'; release_ref?: string; expires_hours?: number;
}): Promise<string> {
  const r = await api.post<{ id: number; code: string; expires_in_hours: number }>('/me/agent/decisions', opts);
  return `Asked (${r.code}); expires in ${r.expires_in_hours} hour(s). The answer will arrive as a decision_reply event in your queue - do not wait in a loop.`;
}

export async function decisions(opts: { status?: string }): Promise<string> {
  const q = opts.status ? `?status=${encodeURIComponent(opts.status)}` : '';
  const rows = await api.get<Decision[]>(`/me/agent/decisions${q}`);
  if (!rows.length) return 'No decisions.';
  return rows.map((d) => `${d.code} [${d.status}] ${d.title}${d.release_ref ? ` (${d.release_ref})` : ''}${d.answer_text ? `\n  answer: ${d.answer_text}` : ''}`).join('\n');
}
