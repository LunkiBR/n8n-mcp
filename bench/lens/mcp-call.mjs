// Calls one tool on the built server over stdio, like an MCP client does.
// Usage: node bench/lens/mcp-call.mjs <tool> '<json args>'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const [tool, rawArgs] = process.argv.slice(2);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, 'dist', 'mcp', 'index.js')],
  env: { ...process.env, MCP_MODE: 'stdio', LOG_LEVEL: 'error', DISABLE_CONSOLE_OUTPUT: 'true', N8N_MCP_TELEMETRY_DISABLED: 'true' },
  stderr: 'ignore',
});
const client = new Client({ name: 'lens-bench', version: '0.0.1' });
await client.connect(transport);
const result = await client.callTool({ name: tool, arguments: JSON.parse(rawArgs || '{}') });
const text = result.content.map(c => c.text ?? '').join('\n');
console.log(text);
console.error(`\n[${tool}] ${text.length} chars ~${Math.ceil(text.length / 3.6)} tok`);
await client.close();
