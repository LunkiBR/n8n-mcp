// The tool interface benchmark agents use: calls one MCP tool on the built server over stdio,
// exactly as an MCP client would, and logs the exchange for token accounting.
//
//   node bench/lens/agent-tool.mjs <tool> '<json args>'
//   node bench/lens/agent-tool.mjs <tool> @args.json  (arguments read from a file)
//   node bench/lens/agent-tool.mjs --list            (tool names, descriptions and input schemas)
//
// Results longer than SPILL_CHARS are written to a file next to BENCH_LOG and only a notice is
// printed, because the shell tool that drives this CLI truncates long output. An MCP client would
// have put the whole result in context, so spilling can only lower a condition's token count.
//
// BENCH_CONDITION selects the server: `upstream` runs an unmodified upstream checkout
// (BENCH_UPSTREAM_ROOT), `fork` runs this repository, `fork-nolens` runs this repository with the
// two lens tools disabled (to separate their effect from other fork changes).
// BENCH_LOG=<file> appends one JSON line per call.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { appendFileSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const condition = process.env.BENCH_CONDITION ?? 'fork';
const root = condition === 'upstream' ? (process.env.BENCH_UPSTREAM_ROOT ?? 'C:/Users/lr103/n8n-bench/upstream') : join(here, '..', '..');
const envFile = process.env.BENCH_ENV ?? 'D:/n8nmcp/testbed/testbed.env';
const fileEnv = existsSync(envFile)
  ? Object.fromEntries(readFileSync(envFile, 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
  : {};
const SPILL_CHARS = 25000;
const env = {
  ...process.env,
  N8N_API_URL: fileEnv.N8N_TESTBED_URL ?? process.env.N8N_API_URL,
  N8N_API_KEY: fileEnv.N8N_API_KEY ?? process.env.N8N_API_KEY,
  WEBHOOK_SECURITY_MODE: 'moderate',
  MCP_MODE: 'stdio',
  LOG_LEVEL: 'error',
  DISABLE_CONSOLE_OUTPUT: 'true',
  N8N_MCP_TELEMETRY_DISABLED: 'true',
  ...(condition === 'fork-nolens' ? { DISABLED_TOOLS: 'n8n_inspect_workflow,n8n_compose_workflow' } : {}),
};

const [tool, rawArgs] = process.argv.slice(2);
const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'dist', 'mcp', 'index.js')], env, stderr: 'ignore' });
const client = new Client({ name: 'lens-bench-agent', version: '0.0.1' });
await client.connect(transport);
try {
  if (tool === '--list') {
    const { tools } = await client.listTools();
    for (const t of tools) console.log(`### ${t.name}\n${t.description}\ninput: ${JSON.stringify(t.inputSchema)}\n`);
  } else {
    let args;
    try {
      const source = rawArgs?.startsWith('@') ? readFileSync(rawArgs.slice(1), 'utf8') : rawArgs || '{}';
      args = JSON.parse(source);
    } catch (error) {
      console.log(`invalid JSON arguments: ${error.message}`);
      process.exit(2);
    }
    const result = await client.callTool({ name: tool, arguments: args });
    const text = result.content.map(c => c.text ?? '').join('\n');
    const argChars = rawArgs?.startsWith('@') ? readFileSync(rawArgs.slice(1), 'utf8').length : (rawArgs ?? '').length;
    let spilled = false;
    if (text.length > SPILL_CHARS && process.env.BENCH_LOG) {
      const file = join(dirname(process.env.BENCH_LOG), `result-${Date.now()}.txt`);
      writeFileSync(file, text);
      console.log(`[result is ${text.length} chars, longer than the shell shows; saved to ${file}. Read or search that file.]`);
      spilled = true;
    } else {
      console.log(text);
    }
    if (process.env.BENCH_LOG) {
      appendFileSync(process.env.BENCH_LOG, JSON.stringify({ t: Date.now(), condition, tool, argChars, resultChars: text.length, spilled, args: JSON.stringify(args).slice(0, 240) }) + '\n');
    }
  }
} finally {
  await client.close();
}
