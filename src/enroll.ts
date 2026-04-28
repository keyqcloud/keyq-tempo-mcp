import { hostname } from 'node:os';
import { getApiUrl, writeToken } from './config.js';

export async function runEnroll(code: string): Promise<void> {
  if (!/^\d{6}$/.test(code)) {
    console.error('Error: enrollment code must be 6 digits.');
    process.exit(1);
  }

  const apiUrl = getApiUrl();
  const deviceName = `${hostname()} (${process.platform})`;

  const res = await fetch(`${apiUrl}/mcp/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, device_name: deviceName }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    console.error(`Enrollment failed (${res.status}): ${data.error || 'unknown error'}`);
    process.exit(1);
  }
  const data = await res.json() as { device_token: string };
  writeToken(data.device_token);

  console.error(`✓ Device enrolled.`);
  console.error(`  Token saved to ~/.keyq-tempo/token (mode 0600)`);
  console.error(``);
  console.error(`Next: add this MCP server to your Claude Code mcp.json:`);
  console.error(``);
  console.error(`  {`);
  console.error(`    "mcpServers": {`);
  console.error(`      "keyq-tempo": {`);
  console.error(`        "command": "npx",`);
  console.error(`        "args": ["-y", "keyq-tempo-mcp"]`);
  console.error(`      }`);
  console.error(`    }`);
  console.error(`  }`);
  console.error(``);
  console.error(`Then restart Claude Code.`);
}
