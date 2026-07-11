// Designs (epic #379) — the Claude Code authoring path (A) for the UI/UX mockup
// review platform. CC crafts screens against the shell template and pushes them
// into a project; screens are sanitized server-side and land in a DRAFT version
// (propose-not-publish) unless `publish` is set. Share links expose the shared
// version to a client for pin-based feedback.

import { api } from '../api.js';

// The web portal that renders /preview/{token} share links.
const WEB_ORIGIN = 'https://tempo.keyq.io';

interface DesignListItem { id: number; title: string; frame_type: string; status: string; version_count: number; current_version_id: number | null; }
interface VersionSummary { id: number; version: number; status: string; changelog: string | null; screen_count: number; open_feedback: number; }
interface DesignDetail { design: { id: number; title: string; frame_type: string; current_version_id: number | null; project_id: number }; versions: VersionSummary[]; }
interface Screen { id: number; screen_key: string; title: string | null; position: number; html: string; }
interface Feedback { id: number; screen_id: number | null; body: string; author_type: string; status: string; }
interface VersionDetail { version: { id: number; version: number; status: string }; screens: Screen[]; feedback: Feedback[]; }

export async function listDesigns(opts: { project_id: number }): Promise<string> {
  const rows = await api.get<DesignListItem[]>(`/projects/${opts.project_id}/designs`);
  if (!rows.length) return `No designs on project #${opts.project_id}. Create one with tempo_create_design.`;
  const header = 'id   frame    versions  title';
  return [header, ...rows.map((d) =>
    `${String(d.id).padEnd(4)} ${(d.frame_type || 'mobile').padEnd(8)} ${String(d.version_count).padEnd(9)} ${d.title}${d.status === 'archived' ? '  (archived)' : ''}`
  )].join('\n');
}

export async function createDesign(opts: { project_id: number; title: string; frame_type?: string }): Promise<string> {
  const res = await api.post<{ id: number; version_id: number; version: number }>(`/projects/${opts.project_id}/designs`, {
    title: opts.title, frame_type: opts.frame_type || 'mobile',
  });
  return `Created design #${res.id} "${opts.title}" (${opts.frame_type || 'mobile'}) on project #${opts.project_id} with empty draft v${res.version}. Author screens with tempo_author_design_screens(design_id: ${res.id}).`;
}

export async function getDesign(opts: { design_id: number }): Promise<string> {
  const detail = await api.get<DesignDetail>(`/designs/${opts.design_id}`);
  const d = detail.design;
  const lines: string[] = [`Design #${d.id} "${d.title}" (${d.frame_type}) — project #${d.project_id}`];
  lines.push('');
  lines.push('Versions:');
  for (const v of detail.versions) {
    lines.push(`  v${v.version} [${v.status}] — ${v.screen_count} screens, ${v.open_feedback} open feedback${v.changelog ? ` — ${v.changelog}` : ''}`);
  }
  // Pull the current version's screens + open feedback so CC can revise from feedback.
  const current = detail.versions.find((v) => v.id === d.current_version_id) || detail.versions[0];
  if (current) {
    const vd = await api.get<VersionDetail>(`/designs/${d.id}/versions/${current.version}`);
    lines.push('');
    lines.push(`Current v${vd.version.version} [${vd.version.status}] screens: ${vd.screens.map((s) => s.screen_key).join(', ') || '(none)'}`);
    const open = vd.feedback.filter((f) => f.status === 'open');
    if (open.length) {
      lines.push('Open feedback:');
      for (const f of open) {
        const scr = vd.screens.find((s) => s.id === f.screen_id);
        lines.push(`  [#${f.id}${scr ? ` @${scr.screen_key}` : ''}] ${f.body}`);
      }
    }
  }
  return lines.join('\n');
}

export async function authorDesignScreens(opts: {
  design_id: number;
  screens: Array<{ screen_key: string; title?: string; html: string; position?: number }>;
  version?: number;
  changelog?: string;
  publish?: boolean;
}): Promise<string> {
  const detail = await api.get<DesignDetail>(`/designs/${opts.design_id}`);
  let targetVid: number;
  let targetVersion: number;

  if (opts.version) {
    const v = detail.versions.find((x) => x.version === opts.version);
    if (!v) return `Design #${opts.design_id} has no version ${opts.version}.`;
    if (v.status !== 'draft') return `v${opts.version} is ${v.status}; screens can only be edited on a draft. Omit 'version' to auto-create a new draft.`;
    targetVid = v.id; targetVersion = v.version;
  } else {
    const current = detail.versions.find((x) => x.id === detail.design.current_version_id);
    if (current && current.status === 'draft') {
      targetVid = current.id; targetVersion = current.version;
    } else {
      // Current version is shared/approved — carry it forward into a new draft.
      const nv = await api.post<{ version_id: number; version: number }>(`/designs/${opts.design_id}/versions`, {
        carry_forward: true, changelog: opts.changelog || 'CC authored revision',
      });
      targetVid = nv.version_id; targetVersion = nv.version;
    }
  }

  const put = await api.put<{ ok: boolean; count: number }>(`/design-versions/${targetVid}/screens`, { screens: opts.screens });
  let note = `Authored ${put.count} screen(s) into design #${opts.design_id} draft v${targetVersion}.`;

  if (opts.publish) {
    await api.patch(`/design-versions/${targetVid}`, { status: 'shared', ...(opts.changelog ? { changelog: opts.changelog } : {}) });
    note += ` Published v${targetVersion} as SHARED (visible to clients + share links).`;
  } else {
    note += ' It is a DRAFT (not yet client-visible). Publish via the web, or pass publish:true, or create a share after publishing.';
  }
  return note;
}

export async function createDesignShare(opts: {
  design_id: number; permission?: string; ai_enabled?: boolean; expires_at?: string;
}): Promise<string> {
  const res = await api.post<{ token: string; preview_path: string }>(`/designs/${opts.design_id}/shares`, {
    permission: opts.permission || 'comment',
    ai_enabled: opts.ai_enabled ?? false,
    expires_at: opts.expires_at,
  });
  const url = `${WEB_ORIGIN}${res.preview_path}`;
  return `Share link created (${opts.permission || 'comment'}${opts.ai_enabled ? ', AI editing enabled' : ''}):\n${url}\n\nNote: the link shows the design's SHARED version. If the design has only draft versions, publish one first (author with publish:true).`;
}
