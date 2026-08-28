import { hostname, platform, homedir } from 'node:os';
import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { getApiUrl, writeToken } from './config.js';

/**
 * Enrol this machine as a FLEET BOX (#743).
 *
 * The difference from `enroll` is what the credential becomes. A personal device token
 * belongs to a person and inherits their access. A fleet box authenticates as ITSELF: the
 * code names an agent, redemption records that agent, and board access comes from the
 * registry rather than from whoever registered it. Who issued the code is kept as an audit
 * fact and confers nothing.
 *
 * It also writes the box's manifest from what the API says it is granted, so onboarding a
 * project becomes a grant rather than a provisioning ritual. That was the setup wall.
 */

const CFG = join(homedir(), '.config', 'tempo-fleet');

function say(msg: string): void { console.error(msg); }

interface ReportReply {
  agent: { id: number; label: string; name: string } | null;
  projects: { project_id: number; code: string; name: string }[];
}

export async function runEnrollFleet(code: string): Promise<void> {
  if (!/^\d{6}$/.test(code)) {
    say('Error: enrollment code must be 6 digits.');
    process.exit(1);
  }

  const apiUrl = getApiUrl();
  const res = await fetch(`${apiUrl}/mcp/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, device_name: `${hostname()} (${platform()})` }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    say(`Enrollment failed (${res.status}): ${data.error || 'unknown error'}`);
    process.exit(1);
  }
  const { device_token: token } = await res.json() as { device_token: string };
  writeToken(token);
  say('✓ Enrolled. Token saved to ~/.keyq-tempo/token (mode 0600).');

  // Ask the API who this box is. Deliberately an ASK, not a deduction: /fleet-agents lists
  // every lane and nothing in it says "you are this one", so inferring from hostname or
  // most-recently-seen would occasionally write a manifest for someone else's lane. The
  // credential carries the answer and this endpoint returns it.
  const reply = await fetch(`${apiUrl}/fleet-agents/me/report`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    // A minimal first report. The real probe belongs to fleet-report.js, which runs on every
    // tick once the scripts are here; claiming a full toolchain list now would put a guess
    // into the registry that nothing had actually observed.
    body: JSON.stringify({ arch: `${process.platform}/${process.arch}`, toolchains: ['node'], tokens: [] }),
  }).then(r => (r.ok ? r.json() as Promise<ReportReply> : null)).catch(() => null);

  if (!reply || !reply.agent) {
    say('');
    say('Enrolled, but this box could not confirm which lane it is. Manifest NOT written —');
    say('a manifest pointed at the wrong lane is worse than none. Check connectivity and');
    say('re-run; enrolment already succeeded, so ask for a fresh code if the old one expired.');
    process.exit(1);
  }

  const { agent, projects } = reply;
  mkdirSync(join(CFG, 'tokens'), { recursive: true });

  const manifestPath = join(CFG, 'manifest.json');
  // Never overwrite an existing manifest. Workspace paths are box-local and hand-chosen, and
  // clobbering them would silently repoint a working box at directories that do not exist.
  // Re-enrolling is a re-key, not a re-provision.
  if (existsSync(manifestPath)) {
    say(`\nA manifest already exists at ${manifestPath} — left untouched.`);
  } else {
    const manifest = {
      agent_label: agent.label,
      projects: projects.map(p => ({
        name: p.code.toLowerCase(),
        workspace: join(homedir(), 'projects', p.code.toLowerCase()),
        org: 'keyqcloud',
      })),
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    try { chmodSync(manifestPath, 0o600); } catch { /* best effort on Windows */ }
    say(`✓ Manifest written for lane ${agent.label} with ${manifest.projects.length} board(s).`);
  }

  say('');
  say(`This box is lane ${agent.label}${agent.name ? ` (${agent.name})` : ''}.`);
  say(projects.length
    ? `Granted boards: ${projects.map(p => p.code).join(', ')}`
    : 'Granted boards: none yet — grant one on the Fleet page and this box will pick it up.');

  // Say plainly what is NOT done, and why it cannot be done from here. The fleet scripts
  // live in a private repo, so fetching them needs a GitHub token this box does not have -
  // that is credential pull, and it is deliberately separate work. Reporting a box as ready
  // when it cannot fetch its own runbook is the silent half-configured state to avoid.
  say('');
  say('Tempo side is done: this box authenticates as itself and is scoped to the boards');
  say('above. It cannot read any other board, whoever registered it.');
  say('');
  say('Still to do on this box (needs a GitHub credential, which does not travel yet):');
  say('  1. Put an org GitHub PAT at ~/.config/tempo-fleet/tokens/<org>   (chmod 600)');
  say('  2. bash ~/.config/tempo-fleet/fleet-sync.sh          # fetch the fleet scripts');
  say('  3. clone the granted repos, then: node ~/.config/tempo-fleet/fleet-provision.js');
  say('  4. schedule run-fleet.sh (cron, launchd, or Task Scheduler)');
}
