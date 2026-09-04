import { hostname, platform, homedir } from 'node:os';
import { mkdirSync, writeFileSync, existsSync, chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
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

interface BootstrapReply {
  files: { name: string; content: string; executable: boolean }[];
  defaults?: { operator_id: number | null; fleet_member_ids: number[]; wip_cap: number };
}

/**
 * Pull this box's ops scripts from Tempo.
 *
 * The circle this breaks: the scripts live in a private repo, so fetching them needs a
 * GitHub credential, and the script that obtains that credential is one of the scripts. The
 * old answer was to have a human place a PAT by hand - which stopped being the design in
 * #692, and stayed in the instructions anyway. Tempo now serves the files, minting and
 * spending the GitHub token server-side, so nothing but the device token is needed here.
 *
 * Returns how it went rather than throwing: a box that enrolled but could not fetch scripts
 * is in a real and recoverable state, and it must be reported as exactly that. Claiming
 * success would be the silent half-configured box this whole design exists to prevent.
 */
async function fetchOpsScripts(apiUrl: string, token: string): Promise<{ ok: boolean; count: number; error?: string }> {
  let reply: BootstrapReply;
  try {
    const res = await fetch(`${apiUrl}/fleet-agents/me/bootstrap`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      return { ok: false, count: 0, error: body.error || `HTTP ${res.status}` };
    }
    reply = await res.json() as BootstrapReply;
  } catch (e) {
    return { ok: false, count: 0, error: e instanceof Error ? e.message : 'network error' };
  }

  if (!reply.files?.length) return { ok: false, count: 0, error: 'the API returned no files' };

  // Write to a temp name and rename, so an interrupted fetch cannot leave a truncated
  // script that would run and half-work. Box-local files are never in this set, so there
  // is nothing here to clobber.
  try {
    mkdirSync(CFG, { recursive: true });
    for (const f of reply.files) {
      const dest = join(CFG, f.name);
      const tmp = `${dest}.tmp`;
      writeFileSync(tmp, Buffer.from(f.content, 'base64'));
      // Mode comes from the repo, not from the extension: work-runbook.md must not be
      // executable, since the agent must not be able to run or rewrite its instructions.
      try { chmodSync(tmp, f.executable ? 0o755 : 0o644); } catch { /* windows: best effort */ }
      renameSync(tmp, dest);
    }

    // defaults.json, which the repo only ships an EXAMPLE of. Without it
    // fleet-add-project.sh refuses with "device base setup missing", so a box could
    // receive every script and still be unable to onboard a project - a half-provisioned
    // state that looks fully provisioned.
    //
    // Never overwritten. Like manifest.json this is box-local: someone may have tuned
    // wip_cap or the escalation list, and clobbering that on a re-enrol would silently
    // change how the box behaves. Re-enrolling is a re-key, not a re-provision.
    const defaultsPath = join(CFG, 'defaults.json');
    if (reply.defaults && !existsSync(defaultsPath)) {
      writeFileSync(defaultsPath, JSON.stringify(reply.defaults, null, 2) + '\n');
      try { chmodSync(defaultsPath, 0o600); } catch { /* windows: best effort */ }
    }
  } catch (e) {
    return { ok: false, count: 0, error: e instanceof Error ? e.message : 'could not write' };
  }
  return { ok: true, count: reply.files.length };
}


/**
 * Make `git clone` work on this box, without leaving a credential on it.
 *
 * The failure this prevents is a nasty one. `run-fleet.sh` and `fleet-add-project.sh` both
 * export GH_TOKEN and assume git will use it - but git does not read that variable. It only
 * works because `gh` can act as a git credential helper AND does read GH_TOKEN, so a box
 * needs `gh auth setup-git` to have been run once. P1 and M1 work because somebody did that
 * by hand long ago and nothing recorded it.
 *
 * On a box where it was never run, a clone fails with:
 *
 *     fatal: could not read Username for 'https://github.com'
 *
 * which reads as a bad token rather than as missing configuration, and sends you looking in
 * entirely the wrong place. L1 lost half an hour to exactly that today.
 *
 * Neither step is fatal. A box that enrols but cannot install gh is still correctly enrolled
 * and can be fixed by hand; failing the whole enrolment over it would be a worse trade.
 */
function ensureGitHubCli(): { gh: boolean; helper: boolean; note?: string } {
  const run = (cmd: string, args: string[], timeout = 180_000): string | null => {
    try {
      return execFileSync(cmd, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { return null; }
  };

  let have = run('gh', ['--version'], 10_000) !== null;

  if (!have) {
    // Non-interactive by construction: `sudo -n` fails immediately rather than sitting at a
    // password prompt inside a detached enrolment nobody is watching.
    if (process.platform === 'darwin') {
      run('brew', ['install', 'gh']);
    } else if (process.platform === 'linux') {
      if (run('sudo', ['-n', 'true'], 5_000) !== null) {
        run('sudo', ['-n', 'apt-get', 'update', '-qq'], 120_000);
        if (run('sudo', ['-n', 'apt-get', 'install', '-y', 'gh']) === null) {
          run('sudo', ['-n', 'dnf', 'install', '-y', 'gh']);
        }
      } else {
        return { gh: false, helper: false, note: 'no passwordless sudo, so gh could not be installed' };
      }
    } else {
      return { gh: false, helper: false, note: `no install recipe for ${process.platform}` };
    }
    have = run('gh', ['--version'], 10_000) !== null;
  }

  if (!have) return { gh: false, helper: false, note: 'install did not produce a working gh' };

  // Writes git's credential.helper for github.com. Deliberately NOT dependent on holding a
  // token right now: this only configures WHERE git should ask, and the answer at run time
  // comes from GH_TOKEN, which the runner brokers per run. So it works on a box that has no
  // boards granted yet and therefore cannot obtain a credential at all.
  const ok = run('gh', ['auth', 'setup-git'], 30_000) !== null;
  if (ok) return { gh: true, helper: true };

  // Fall back to writing what setup-git would have written. Same effect; the only loss is
  // the absolute path to the binary, so gh has to be on PATH at run time - which run-fleet
  // ensures for itself.
  const wrote = run('git', ['config', '--global', 'credential.https://github.com.helper',
    '!gh auth git-credential'], 10_000) !== null;
  return { gh: true, helper: wrote, note: wrote ? undefined : 'could not configure git to use gh' };
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

  // Everything past this point writes to CFG, so prove it is writable HERE rather than
  // discovering it three statements later as an unhandled EACCES and a Node stack trace.
  //
  // Found on the first real box: the Slipstream agent installer had created ~/.config as
  // root:root, so the login user could not make a directory inside it. Enrolment had
  // already succeeded and the token was already on disk, and what the operator saw was a
  // crash - which reads as "enrolment failed", the one thing that had not happened.
  try {
    mkdirSync(join(CFG, 'tokens'), { recursive: true });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    say('');
    say(`\u2717 Enrolled, but this box cannot write ${CFG}`);
    say(`  ${why}`);
    say('');
    say('The token IS saved and enrolment stands - do not ask for a new code. This is a');
    say('permissions problem on the box, not a Tempo one.');
    say('');
    say('Most likely: ~/.config is owned by root because some installer created it that');
    say('way. Check with `ls -lad ~/.config`, and if so:');
    say(`  sudo chown $(id -un):$(id -gn) ${join(CFG, '..')}`);
    say('');
    say('Then re-run this command with the same code if it has not expired, or a new one.');
    process.exitCode = 1;
    return;
  }

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
    try {
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    } catch (e) {
      say(`\u2717 Enrolled, but the manifest could not be written: ${e instanceof Error ? e.message : e}`);
      say('The token IS saved and enrolment stands - do not ask for a new code.');
      process.exitCode = 1;
      return;
    }
    try { chmodSync(manifestPath, 0o600); } catch { /* best effort on Windows */ }
    say(`✓ Manifest written for lane ${agent.label} with ${manifest.projects.length} board(s).`);
  }

  say('');
  say(`This box is lane ${agent.label}${agent.name ? ` (${agent.name})` : ''}.`);
  say(projects.length
    ? `Granted boards: ${projects.map(p => p.code).join(', ')}`
    : 'Granted boards: none yet — grant one on the Fleet page and this box will pick it up.');

  say('');
  say('Tempo side is done: this box authenticates as itself and is scoped to the boards');
  say('above. It cannot read any other board, whoever registered it.');

  // Fetch the ops scripts with the credential just issued. This is the step that used to be
  // a hand-placed PAT and a paragraph of instructions.
  say('');
  say('Fetching ops scripts...');
  const scripts = await fetchOpsScripts(apiUrl, token);
  if (scripts.ok) {
    say(`\u2713 ${scripts.count} script(s) written to ${CFG}.`);

    say('Setting up git access...');
    const gh = ensureGitHubCli();
    if (gh.gh && gh.helper) {
      say('\u2713 gh is installed and git is configured to use it for GitHub.');
    } else {
      // Named rather than passed over. This box will clone fine by hand and fail on a
      // scheduled run, which is the worst way to find out.
      say(`\u2717 git access is NOT set up${gh.note ? ` (${gh.note})` : ''}.`);
      say('  Clones will fail with "could not read Username for https://github.com".');
      say('  Fix on this box with:  gh auth setup-git');
      say(gh.gh ? '' : '  (install gh first: apt-get install gh, dnf install gh, or brew install gh)');
    }

    say('');
    say('Still to do on this box:');
    say('  1. Install Claude Code and log in.  The runner shells out to `claude`, and');
    say('     signing in is interactive, so this one genuinely cannot be automated.');
    say('  2. Onboard each granted board:');
    say(`       bash ${join(CFG, 'fleet-add-project.sh')} \\`);
    say('         --name <board> --repo <git-url> --org <org> --project-id <id> \\');
    say('         --verify "<build or test command>"');
    say('     This clones the repo and writes its sprint config. No PAT needed - it asks');
    say('     Tempo for a short-lived credential, the same way the runner does.');
    say('  3. Schedule run-fleet.sh (cron, launchd, or Task Scheduler).');
    say('');
    say('Nothing above needs a GitHub credential stored on this box. Work repos are');
    say('authenticated per run with a short-lived token from Tempo.');
    say('');
    // fleet-provision.js used to be listed here as "clone the granted repos", which it has
    // never done - it renders sprint config for workspaces that already exist, and defaults
    // to a dry run. Pointing a new operator at it as step one sent them to a command that
    // would report nothing to do and leave them stuck.
    say(`Later, when board grants change: node ${join(CFG, 'fleet-provision.js')} to preview`);
    say('the new config, then the same with --apply. It renders config only; it does not');
    say('clone.');
    return;
  }

  // Enrolled but not provisioned. Named as a distinct state, loudly, because it is the one
  // that otherwise looks like success - the box has a token, Tempo lists it, and nothing
  // says the scripts never arrived until a scheduled run does nothing at 3am.
  say(`\u2717 Could not fetch the ops scripts: ${scripts.error}`);
  say('');
  say('This box is ENROLLED but NOT provisioned. Enrolment stands - do not ask for a new');
  say('code. Re-run this once the cause is fixed, or sync by hand if the box already has a');
  say('copy of fleet-sync.sh.');
  say('');
  say('Most likely causes, in order: this box has no board granted yet (grant one on the');
  say('Fleet page), or the GitHub App has no access to the ops repo.');
  process.exitCode = 1;
}
