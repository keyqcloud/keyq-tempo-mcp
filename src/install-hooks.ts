import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

// Copy templates/pre-push into the current git repo's .git/hooks/.
// Run from the repo root after enrolling. Idempotent — safe to re-run.
//
// Resolves the templates directory relative to this file's location, so it
// works whether the package was installed via npx (extracted into npm cache)
// or cloned + linked locally.
export async function runInstallHooks(): Promise<void> {
  // Find the repo root via `git rev-parse`.
  let repoRoot: string;
  try {
    repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
  } catch {
    console.error('Error: not inside a git repository.');
    process.exit(1);
  }

  // The templates directory ships alongside dist/ in the published package.
  // From dist/index.js the templates/ sit at ../templates relative to dist/.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'templates', 'pre-push'),    // installed: dist/index.js → ../templates/
    join(here, '..', '..', 'templates', 'pre-push'), // dev: src/install-hooks.ts → ../../templates/
  ];
  const templatePath = candidates.find((p) => existsSync(p));
  if (!templatePath) {
    console.error('Error: pre-push template not found in package.');
    console.error(`Searched: ${candidates.join(', ')}`);
    process.exit(1);
  }

  const hooksDir = join(repoRoot, '.git', 'hooks');
  const target = join(hooksDir, 'pre-push');

  if (existsSync(target)) {
    const existing = readFileSync(target, 'utf8');
    if (existing.includes('# tempo-sprint-mode pre-push guard')) {
      console.error(`✓ tempo-sprint-mode pre-push hook already installed at ${target}`);
      return;
    }
    console.error(`Error: ${target} already exists and is not the tempo hook.`);
    console.error(`       Move or merge it manually before re-running install-hooks.`);
    process.exit(1);
  }

  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });
  const content = readFileSync(templatePath, 'utf8');
  writeFileSync(target, content);
  try { chmodSync(target, 0o755); } catch { /* windows: no-op, git for windows handles execute bit */ }

  console.error(`✓ Installed tempo-sprint-mode pre-push hook at ${target}`);
  console.error(`  Refuses pushes to the target_branch from .claude/sprint-config.json`);
  console.error(`  Bypass for a one-off:  SKIP_TEMPO_HOOK=1 git push`);
}
