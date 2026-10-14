// Software releases (epic #1044, card #1048) - the Claude Code side. CC can see a
// customer's products and versions, create a DRAFT version, upload installers to it
// from disk, and read the problems customers reported on a version. Publishing,
// archiving and deleting are a person's call: the API refuses them for device tokens,
// and nothing here tries.

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { api } from '../api.js';

const WEB_ORIGIN = 'https://tempo.keyq.io';
const PLATFORMS = ['windows', 'macos', 'linux', 'other'] as const;
type Platform = typeof PLATFORMS[number];

interface ProductRow {
  id: number; name: string; customer_name?: string; project_name: string | null; status: string;
  latest_version: string | null; latest_published_at: string | null; version_count: number; draft_count?: number;
}
interface FileRow { id: number; platform: string; filename: string; size_bytes: number; sha256: string | null; status: string }
interface VersionRow {
  id: number; version: string; notes: string | null; status: string; source: string; published_at: string | null; created_at: string;
  files: FileRow[]; download_count?: number; report_count?: number; open_report_count?: number; commit_sha?: string | null;
}
interface ProductDetail {
  id: number; name: string; customer_name: string | null; project_name: string | null; status: string; description: string | null;
  latest_version_id: number | null; auto_publish_ci?: number; notify_on_release?: number; versions: VersionRow[];
}
interface ReportRow { id: number; title: string; status: string; priority: string; created_at: string; reporter_name: string | null; reporter_email: string | null; attachment_count: number }
interface Attachment { id: number; filename: string; size_bytes: number; content_type: string | null }
interface TicketDetail { id: number; description: string | null; comments?: { user_name: string | null; user_role: string; content: string; created_at: string }[] }

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const productLink = (id: number) => `${WEB_ORIGIN}/software/${id}`;

function guessPlatform(name: string): Platform {
  const f = name.toLowerCase();
  if (/\.(exe|msi|msix|msixbundle|appx|appxbundle)$/.test(f)) return 'windows';
  if (/\.(dmg|pkg)$/.test(f) || /\.app\.(zip|tar\.gz)$/.test(f) || /(mac|darwin|osx)/.test(f)) return 'macos';
  if (/\.(deb|rpm|appimage|snap|flatpak)$/.test(f) || /linux/.test(f)) return 'linux';
  return 'other';
}

export async function listSoftware(opts: { customer_id?: number; include_archived?: boolean }): Promise<string> {
  const q = new URLSearchParams();
  if (opts.customer_id) q.set('customer_id', String(opts.customer_id));
  if (opts.include_archived) q.set('include_archived', '1');
  const qs = q.toString();
  const rows = await api.get<ProductRow[]>(`/software/products${qs ? `?${qs}` : ''}`);
  if (!rows.length) return 'No software products match. Products are created by a person in Tempo (Software > New product).';
  return rows.map((p) => {
    const latest = p.latest_version ? `latest ${p.latest_version}` : 'nothing published yet';
    const drafts = p.draft_count ? `, ${p.draft_count} draft${p.draft_count === 1 ? '' : 's'}` : '';
    return `#${p.id} "${p.name}" — ${p.customer_name ?? ''}${p.project_name ? ` / ${p.project_name}` : ''} — ${latest}${drafts}${p.status === 'archived' ? ' (archived)' : ''}`;
  }).join('\n');
}

export async function listVersions(opts: { product_id: number }): Promise<string> {
  const p = await api.get<ProductDetail>(`/software/products/${opts.product_id}`);
  const head = [
    `# ${p.name} (product #${p.id}) — ${p.customer_name ?? ''}${p.project_name ? ` / ${p.project_name}` : ''}${p.status === 'archived' ? ' — ARCHIVED' : ''}`,
    p.description ?? '',
    `CI auto-publish: ${p.auto_publish_ci ? 'on' : 'off'} · release email: ${p.notify_on_release ? 'on' : 'off'} · ${productLink(p.id)}`,
  ].filter(Boolean);
  if (!p.versions.length) return `${head.join('\n')}\n\nNo versions yet. Create one with tempo_create_version.`;
  const body = p.versions.map((v) => {
    const status = v.id === p.latest_version_id ? 'published, LATEST' : v.status;
    const facts = [
      v.published_at ? `published ${v.published_at}` : `created ${v.created_at}`,
      v.source !== 'web' ? `from ${v.source}${v.commit_sha ? ` @ ${v.commit_sha.slice(0, 7)}` : ''}` : '',
      v.download_count !== undefined ? `${v.download_count} downloads` : '',
      v.report_count ? `${v.report_count} problem report${v.report_count === 1 ? '' : 's'} (${v.open_report_count ?? 0} open)` : '',
    ].filter(Boolean).join(' · ');
    const files = v.files.length
      ? v.files.map((f) => `  - [${f.platform}] ${f.filename} (${mb(f.size_bytes)})${f.status !== 'ready' ? ' — UNFINISHED UPLOAD' : ''}${f.sha256 ? ` sha256 ${f.sha256}` : ''} (file #${f.id})`).join('\n')
      : '  (no files)';
    return `## ${v.version} — version #${v.id} — ${status}\n${facts}\n${files}${v.notes ? `\nNotes:\n${v.notes}` : ''}`;
  });
  return `${head.join('\n')}\n\n${body.join('\n\n')}`;
}

export async function createVersion(opts: { product_id: number; version: string; notes?: string }): Promise<string> {
  const r = await api.post<{ id: number }>(`/software/products/${opts.product_id}/versions`, { version: opts.version, notes: opts.notes });
  return `Created DRAFT version ${opts.version} (version #${r.id}). Customers cannot see it.\n`
    + `Next: tempo_upload_version_file(version_id: ${r.id}, path: "<absolute path to the installer>") for each installer. `
    + `Then tell the operator it is ready to publish at ${productLink(opts.product_id)} — publishing is theirs to do.`;
}

export async function uploadVersionFile(opts: { version_id: number; path: string; platform?: Platform }): Promise<string> {
  let size: number;
  try {
    const st = statSync(opts.path);
    if (!st.isFile()) throw new Error('not a file');
    size = st.size;
  } catch { throw new Error(`No file at ${opts.path}. Pass an absolute path to the installer.`); }
  if (!size) throw new Error(`${opts.path} is empty.`);
  const filename = basename(opts.path);
  const platform = opts.platform ?? guessPlatform(filename);
  const start = await api.post<{ file_id: number; part_size: number; part_count: number }>(`/software/versions/${opts.version_id}/files`, {
    filename, platform, size_bytes: size, content_type: 'application/octet-stream',
  });
  const parts: { part_number: number; etag: string }[] = [];
  const fd = openSync(opts.path, 'r');
  try {
    for (let n = 1; n <= start.part_count; n++) {
      const length = Math.min(start.part_size, size - (n - 1) * start.part_size);
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, (n - 1) * start.part_size);
      try {
        parts.push(await api.putBytes<{ part_number: number; etag: string }>(`/software/files/${start.file_id}/parts/${n}`, buf));
      } catch (e) {
        // An unfinished upload is useless; remove it so a retry starts clean.
        await api.delete(`/software/files/${start.file_id}`).catch(() => undefined);
        throw new Error(`Upload failed on part ${n} of ${start.part_count}: ${e instanceof Error ? e.message : e}. Nothing was kept; try again.`);
      }
    }
  } finally { closeSync(fd); }
  const done = await api.post<{ sha256: string | null }>(`/software/files/${start.file_id}/complete`, { parts });
  return `Uploaded ${filename} (${mb(size)}, ${platform}) to version #${opts.version_id} as file #${start.file_id}.\n`
    + `SHA-256 (computed by Tempo from what it stored): ${done.sha256 ?? 'not available'}`;
}

export async function getVersionReports(opts: { version_id: number }): Promise<string> {
  const rows = await api.get<ReportRow[]>(`/software/versions/${opts.version_id}/reports`);
  if (!rows.length) return 'No problems have been reported on this version.';
  // The full text of the most recent reports, which is what a fix needs; the rest as a list.
  const detailed = rows.slice(0, 10);
  const details = await Promise.all(detailed.map((r) => api.get<TicketDetail>(`/tickets/${r.id}`).catch(() => null)));
  const files = await Promise.all(detailed.map((r) => (r.attachment_count
    ? api.get<Attachment[]>(`/attachments?parent_type=ticket&parent_id=${r.id}`).catch(() => [])
    : Promise.resolve([] as Attachment[]))));
  const blocks = detailed.map((r, i) => {
    const d = details[i];
    const atts = files[i].map((a) => `  - attachment #${a.id}: ${a.filename} (${a.size_bytes} bytes${a.content_type ? `, ${a.content_type}` : ''})`).join('\n');
    const thread = (d?.comments ?? []).map((c) => `  > ${c.user_name ?? 'someone'} (${c.user_role}, ${c.created_at}): ${c.content.replace(/\n/g, '\n  > ')}`).join('\n');
    return [
      `## Ticket #${r.id}: ${r.title} — ${r.status}, ${r.priority}`,
      `Reported ${r.created_at} by ${r.reporter_name ?? r.reporter_email ?? 'unknown'}`,
      d?.description ? d.description : '(no details given)',
      atts ? `Attachments (read text ones such as logs with tempo_read_attachment):\n${atts}` : '',
      thread ? `Comments:\n${thread}` : '',
    ].filter(Boolean).join('\n');
  });
  const rest = rows.slice(10).map((r) => `- #${r.id} ${r.title} — ${r.status} (${r.created_at})`);
  return [`${rows.length} problem report${rows.length === 1 ? '' : 's'} on version #${opts.version_id}:`, '', ...blocks, ...(rest.length ? ['', 'Older:', ...rest] : [])].join('\n\n');
}

export { PLATFORMS };
