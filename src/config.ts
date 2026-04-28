import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';

const DEFAULT_API_URL = 'https://tempo-api.keyq.io';
const CONFIG_DIR = join(homedir(), '.keyq-tempo');
const TOKEN_PATH = join(CONFIG_DIR, 'token');
const URL_PATH = join(CONFIG_DIR, 'api-url');

export function getApiUrl(): string {
  if (process.env.KEYQ_TEMPO_API_URL) return process.env.KEYQ_TEMPO_API_URL;
  if (existsSync(URL_PATH)) return readFileSync(URL_PATH, 'utf8').trim() || DEFAULT_API_URL;
  return DEFAULT_API_URL;
}

export function setApiUrl(url: string): void {
  ensureConfigDir();
  writeFileSync(URL_PATH, url, { encoding: 'utf8', mode: 0o600 });
}

export function readToken(): string | null {
  try {
    if (!existsSync(TOKEN_PATH)) return null;
    return readFileSync(TOKEN_PATH, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function writeToken(token: string): void {
  ensureConfigDir();
  writeFileSync(TOKEN_PATH, token, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(TOKEN_PATH, 0o600); } catch { /* windows: best effort */ }
}

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try { chmodSync(CONFIG_DIR, 0o700); } catch { /* windows: best effort */ }
}
