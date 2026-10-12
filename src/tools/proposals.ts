// Proposals (epic #1010, card #1018) — the Claude Code authoring path. CC writes a
// proposal as a folder (index.html + tempo-proposal.json + assets), uploads it into
// a DRAFT version, reads the server's checks back, and later reads what the client
// submitted to write the next version. Publishing is a person's call: the API
// refuses it for device tokens, and nothing here tries.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { api } from '../api.js';
import guide from '../guides/proposal-authoring.md';

const WEB_ORIGIN = 'https://tempo.keyq.io';
const MANIFEST = 'tempo-proposal.json';
// The API's limits, checked here first so a too-big bundle fails before any upload.
const MAX_FILES = 200;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const SEGMENT = /^[A-Za-z0-9._ -]+$/;

interface ProposalListRow {
  id: number; public_id: string; title: string; status: string;
  customer_name: string | null; lead_name: string | null; lead_company: string | null; prospect_name: string | null;
  project_name: string | null; language: string; guest_access_enabled: number;
  latest_version: number | null; published_version: number | null; updated_at: string;
}
interface VersionRow { id: number; version: number; status: string; file_count: number; item_count: number; changelog: string | null }
interface ProposalDetail { proposal: { id: number; title: string; status: string }; versions: VersionRow[] }
interface Finding { code: string; message: string; path?: string; anchor?: string; host?: string; keys?: string[] }
interface Validation { errors: Finding[]; warnings: Finding[]; info: Finding[] }

export function authoringGuide(): string {
  return guide;
}

function attachedTo(p: ProposalListRow): string {
  if (p.customer_name) return p.customer_name;
  if (p.lead_name || p.lead_company) return `lead: ${[p.lead_name, p.lead_company].filter(Boolean).join(', ')}`;
  return p.prospect_name ? `prospect: ${p.prospect_name}` : '-';
}

export async function listProposals(opts: { customer_id?: number; lead_id?: number; status?: string }): Promise<string> {
  const q = new URLSearchParams();
  if (opts.customer_id) q.set('customer_id', String(opts.customer_id));
  if (opts.lead_id) q.set('lead_id', String(opts.lead_id));
  if (opts.status) q.set('status', opts.status);
  const qs = q.toString();
  const rows = await api.get<ProposalListRow[]>(`/proposals${qs ? `?${qs}` : ''}`);
  if (!rows.length) return 'No proposals match. Create one with tempo_create_proposal.';
  return rows.map((p) => {
    const ver = p.published_version
      ? `published v${p.published_version}${p.latest_version && p.latest_version > p.published_version ? `, draft v${p.latest_version}` : ''}`
      : `draft v${p.latest_version ?? 1}, not published`;
    const flags = [p.status === 'archived' ? 'archived' : '', p.guest_access_enabled ? 'guest access on' : ''].filter(Boolean);
    return `#${p.id} "${p.title}" — ${attachedTo(p)}${p.project_name ? ` / ${p.project_name}` : ''} — ${ver}${flags.length ? ` (${flags.join(', ')})` : ''}`;
  }).join('\n');
}

export async function createProposal(opts: {
  title: string; customer_id?: number; lead_id?: number; prospect_name?: string; project_id?: number; language?: 'en' | 'ja';
}): Promise<string> {
  const res = await api.post<{ id: number; public_id: string; version: number }>('/proposals', opts);
  return `Created proposal #${res.id} "${opts.title}" with an empty draft v${res.version}.\n`
    + `Next: call tempo_proposal_authoring_guide if you have not, write the folder, then tempo_upload_proposal_version(proposal_id: ${res.id}, path: "<folder>").`;
}

// --- Upload ---

interface Bundle { files: Map<string, string>; manifest: string | null; skipped: string[] }

function walk(root: string, dir: string, out: Bundle): void {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue; // .git, .DS_Store: never content
    const abs = join(dir, ent.name);
    const rel = relative(root, abs).split(sep).join('/');
    if (ent.isDirectory()) { walk(root, abs, out); continue; }
    if (!ent.isFile()) continue;
    if (rel === MANIFEST) { out.manifest = abs; continue; }
    if (rel.length > 300 || !rel.split('/').every((s) => SEGMENT.test(s))) { out.skipped.push(rel); continue; }
    out.files.set(rel, abs);
  }
}

function readBundle(path: string): Bundle {
  const abs = resolve(path);
  let st;
  try { st = statSync(abs); } catch { throw new Error(`No file or folder at ${path}. Pass an absolute path.`); }
  const out: Bundle = { files: new Map(), manifest: null, skipped: [] };
  if (st.isDirectory()) {
    walk(abs, abs, out);
    return out;
  }
  if (!/\.html?$/i.test(abs)) throw new Error(`${path} is neither a folder nor an .html file`);
  // A single page goes up as index.html; a manifest beside it is still read.
  out.files.set('index.html', abs);
  const beside = join(dirname(abs), MANIFEST);
  try { if (statSync(beside).isFile()) out.manifest = beside; } catch { /* none */ }
  return out;
}

function fmtBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function fmtFinding(f: Finding): string {
  const where = [f.path, f.anchor && `anchor ${f.anchor}`, f.host].filter(Boolean).join(', ');
  return `- [${f.code}] ${f.message}${where && !f.message.includes(where) ? ` (${where})` : ''}${f.keys?.length ? `: ${[...f.keys].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join(', ')}` : ''}`;
}

export async function uploadProposalVersion(opts: { proposal_id: number; path: string; changelog?: string }): Promise<string> {
  const bundle = readBundle(opts.path);
  if (!bundle.files.has('index.html')) {
    return `No index.html at the top of ${opts.path}. The entry file must be named index.html. Nothing was uploaded.`;
  }

  // Everything that can fail locally fails before anything is sent.
  let items: unknown[] | null = null;
  if (bundle.manifest) {
    let parsed: { items?: unknown };
    try { parsed = JSON.parse(readFileSync(bundle.manifest, 'utf8')); } catch (e) {
      return `${MANIFEST} is not valid JSON: ${e instanceof Error ? e.message : e}. Nothing was uploaded.`;
    }
    if (!Array.isArray(parsed.items)) return `${MANIFEST} needs an "items" array. Nothing was uploaded.`;
    items = parsed.items;
  }
  const sizes = [...bundle.files].map(([rel, abs]) => [rel, statSync(abs).size] as const);
  const total = sizes.reduce((s, [, n]) => s + n, 0);
  const tooBig = sizes.filter(([, n]) => n > MAX_FILE_BYTES).map(([rel]) => rel);
  if (sizes.length > MAX_FILES || total > MAX_TOTAL_BYTES || tooBig.length) {
    return `Too big for a proposal (limits: ${MAX_FILES} files, ${fmtBytes(MAX_FILE_BYTES)} per file, ${fmtBytes(MAX_TOTAL_BYTES)} in total). `
      + `This bundle: ${sizes.length} files, ${fmtBytes(total)}${tooBig.length ? `; over the per-file limit: ${tooBig.join(', ')}` : ''}. Nothing was uploaded.`;
  }

  // Reuse the latest version while it is still a draft, so the fix-and-re-upload
  // loop does not leave a trail of abandoned drafts. Otherwise start a new one.
  const detail = await api.get<ProposalDetail>(`/proposals/${opts.proposal_id}`);
  if (detail.proposal.status !== 'active') return `Proposal #${opts.proposal_id} is archived. Nothing was uploaded.`;
  const latest = detail.versions[0];
  let versionId: number; let version: number; let reused = false;
  if (latest && latest.status === 'draft') {
    versionId = latest.id; version = latest.version; reused = true;
  } else {
    const nv = await api.post<{ version_id: number; version: number }>(`/proposals/${opts.proposal_id}/versions`, {
      ...(opts.changelog ? { changelog: opts.changelog } : {}),
    });
    versionId = nv.version_id; version = nv.version;
  }

  // Items first: a manifest the server rejects stops the upload before any file moves.
  let itemCount: number | null = null;
  if (items) {
    try {
      itemCount = (await api.put<{ count: number }>(`/proposal-versions/${versionId}/items`, { items })).count;
    } catch (e) {
      return `${MANIFEST} was rejected: ${e instanceof Error ? e.message : e}. No files were uploaded; fix the manifest and upload again (draft v${version} is reused).`;
    }
  }

  const existing = (await api.get<{ files: { path: string }[]; items: unknown[] }>(`/proposal-versions/${versionId}`));
  const queue = [...bundle.files.keys()];
  const failed: string[] = [];
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let rel = queue.shift(); rel !== undefined; rel = queue.shift()) {
      const url = `/proposal-versions/${versionId}/files/${rel.split('/').map(encodeURIComponent).join('/')}`;
      try { await api.putBytes(url, readFileSync(bundle.files.get(rel)!)); } catch (e) {
        failed.push(`${rel}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }));
  if (failed.length) {
    return `Upload into draft v${version} stopped with ${failed.length} failed file(s):\n${failed.map((f) => `- ${f}`).join('\n')}\n`
      + 'The draft is incomplete. Fix the cause and upload again; the same draft is reused.';
  }
  const stale = existing.files.map((f) => f.path).filter((p) => !bundle.files.has(p));
  for (const p of stale) await api.delete(`/proposal-versions/${versionId}/files/${p.split('/').map(encodeURIComponent).join('/')}`);

  const fin = await api.post<{ ok: boolean; validation: Validation }>(`/proposal-versions/${versionId}/finalize`);
  const v = fin.validation;

  const lines: string[] = [];
  lines.push(`Uploaded ${bundle.files.size} file(s), ${fmtBytes(total)}, into proposal #${opts.proposal_id} "${detail.proposal.title}" `
    + `${reused ? 'existing ' : 'new '}draft v${version}${stale.length ? ` (removed ${stale.length} file(s) no longer in the folder)` : ''}.`);
  if (itemCount !== null) lines.push(`Items: ${itemCount} from ${MANIFEST}.`);
  else lines.push(`Items: no ${MANIFEST} found; the draft keeps its ${existing.items.length} existing item(s)${existing.items.length && !reused ? ' (carried over from the previous version)' : ''}.`);
  if (bundle.skipped.length) lines.push(`Skipped (names must use letters, digits, ". _ -" and spaces): ${bundle.skipped.join(', ')}`);
  if (reused && opts.changelog) lines.push('Note: the changelog is set when a draft is created; this draft already existed, so it keeps its own.');
  lines.push('');
  lines.push(`Checks: ${v.errors.length} error(s), ${v.warnings.length} warning(s), ${v.info.length} info.`);
  if (v.errors.length) lines.push('ERRORS (the version cannot be published until these are fixed):', ...v.errors.map(fmtFinding));
  if (v.warnings.length) lines.push('WARNINGS (fix these, then upload again):', ...v.warnings.map(fmtFinding));
  if (v.info.length) lines.push('INFO:', ...v.info.map(fmtFinding));
  lines.push('');
  lines.push(`This is a DRAFT; clients cannot see it. A person reviews and publishes it in Tempo: ${WEB_ORIGIN}/proposals/${opts.proposal_id}`);
  return lines.join('\n');
}

// --- Feedback ---

interface FbItem { item_key: string; kind: string; group_label: string | null; text: string; detail: string | null; answer_type: string | null; options: string[] | null; default_answer: unknown }
interface FbReviewer { id: number; kind: string; email: string | null; name: string | null; last_viewed_at: string | null }
interface FbResponse { item_key: string; reviewer_id: number; type: string; value: unknown; at: string; changed_after_submission: boolean; question_changed: boolean; retired: boolean }
interface FbComment {
  id: number; parent_id: number | null; author_side: string; reviewer_id: number | null; anchor: string | null;
  context_key: string | null; context_label: string | null; body: string; internal: number; resolved_at: string | null;
  author_name: string | null; created_at: string;
}
interface FbSubmission { reviewer_id: number; created_at: string; summary: { answers: number; accepted_defaults: number; confirmations: number; corrections: number; comments: number } | null }
interface Feedback {
  proposal: { id: number; title: string; published_version_id: number | null };
  items: FbItem[]; reviewers: FbReviewer[]; responses: FbResponse[]; comments: FbComment[]; submissions: FbSubmission[];
}

function show(v: unknown): string {
  if (v == null) return '';
  return Array.isArray(v) ? v.join(', ') : String(v);
}

function describeResponse(r: FbResponse): string {
  const flags = [
    r.question_changed ? 'answered an earlier wording: re-check' : '',
    r.changed_after_submission ? 'reviewer is editing this again (unsent)' : '',
  ].filter(Boolean);
  const what = r.type === 'confirm' ? 'confirmed'
    : r.type === 'correct' ? `CORRECTED: ${show(r.value)}`
    : r.type === 'accept_default' ? `accepted the default (${show(r.value)})`
    : `answered: ${show(r.value)}`;
  return `${what}${flags.length ? ` [${flags.join('; ')}]` : ''}`;
}

export async function getProposalFeedback(opts: { proposal_id: number }): Promise<string> {
  const fb = await api.get<Feedback>(`/proposals/${opts.proposal_id}/feedback`);
  // Short names on every line; the email once, in the reviewer list.
  const who = new Map(fb.reviewers.map((r) => [r.id, r.name || r.email || `reviewer ${r.id}`]));
  const out: string[] = [`# Feedback on proposal #${fb.proposal.id} "${fb.proposal.title}"`];
  if (!fb.proposal.published_version_id) {
    out.push('', 'Not published yet, so there is no client feedback. Only submitted answers and posted comments ever appear here.');
    return out.join('\n');
  }

  out.push('', `Reviewers: ${fb.reviewers.length ? fb.reviewers.map((r) => `${who.get(r.id)}${r.name && r.email ? ` <${r.email}>` : ''} (${r.kind})`).join('; ') : 'none yet'}`);
  if (fb.submissions.length) {
    out.push('Submissions (newest first):');
    for (const s of fb.submissions) {
      const m = s.summary;
      out.push(`- ${s.created_at} UTC, ${who.get(s.reviewer_id) ?? 'reviewer'}${m ? `: answered ${m.answers}, accepted defaults ${m.accepted_defaults}, confirmed ${m.confirmations}, corrected ${m.corrections}, comments ${m.comments}` : ''}`);
    }
  } else {
    out.push('Nobody has submitted yet.');
  }

  const byItem = new Map<string, FbResponse[]>();
  for (const r of fb.responses) byItem.set(r.item_key, [...(byItem.get(r.item_key) ?? []), r]);
  out.push('', '## Items (published version)');
  let group: string | null | undefined;
  for (const it of fb.items) {
    if (it.group_label !== group) { group = it.group_label; out.push('', `### ${group ?? '(no group)'}`); }
    const kind = it.kind === 'assumption' ? 'assumption' : `question, ${it.answer_type ?? 'text'}`;
    out.push(`**${it.item_key}** (${kind}) ${it.text}`);
    if (it.options?.length) out.push(`  options: ${it.options.join(' | ')}`);
    if (it.default_answer != null && it.default_answer !== '') out.push(`  default: ${show(it.default_answer)}`);
    const rs = byItem.get(it.item_key) ?? [];
    if (!rs.length) out.push('  - (no submitted response)');
    for (const r of rs) out.push(`  - ${who.get(r.reviewer_id) ?? 'reviewer'}: ${describeResponse(r)}`);
  }
  const retired = fb.responses.filter((r) => r.retired);
  if (retired.length) {
    out.push('', '## Answers to items no longer in the published version');
    for (const r of retired) out.push(`- ${r.item_key}, ${who.get(r.reviewer_id) ?? 'reviewer'}: ${describeResponse(r)}`);
  }

  out.push('', '## Comments');
  if (!fb.comments.length) out.push('None posted.');
  const children = new Map<number, FbComment[]>();
  for (const c of fb.comments) if (c.parent_id) children.set(c.parent_id, [...(children.get(c.parent_id) ?? []), c]);
  const line = (c: FbComment, indent: string) => {
    const author = c.author_side === 'team' ? `${c.author_name ?? 'team'} (team)` : (c.reviewer_id ? who.get(c.reviewer_id) : c.author_name) ?? 'reviewer';
    const pinned = [c.anchor && `on ${c.anchor}`, c.context_key && `while viewing ${c.context_label ? `"${c.context_label}" ` : ''}(${c.context_key})`].filter(Boolean).join(', ');
    const flags = [c.internal ? 'INTERNAL NOTE, the client cannot see it' : '', c.resolved_at ? 'resolved' : ''].filter(Boolean);
    out.push(`${indent}- [#${c.id}] ${author}${pinned ? `, ${pinned}` : ''}, ${c.created_at} UTC${flags.length ? ` [${flags.join('; ')}]` : ''}:`);
    out.push(`${indent}  ${c.body.replace(/\n/g, `\n${indent}  `)}`);
    for (const k of children.get(c.id) ?? []) line(k, `${indent}  `);
  };
  for (const c of fb.comments.filter((x) => !x.parent_id)) line(c, '');

  out.push('', 'Drafts the client has not submitted are never included.');
  return out.join('\n');
}
