// Prepares a benchmark run and prints the agent prompt.
// Usage: node bench/lens/prompt.mjs <taskId> <condition> <runId>
// The prompt is identical across conditions except for the tool list file and the condition name
// in the command line, which only selects the server.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const here = dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/');
const RUNS = 'D:/n8nmcp/bench-runs';
const [taskId, condition, runId] = process.argv.slice(2);
const task = JSON.parse(readFileSync(join(here, 'tasks.json'), 'utf8'))[taskId];
const dir = `${RUNS}/${runId}`;
mkdirSync(dir, { recursive: true });

const toolsFile = `${RUNS}/tools-${condition}.txt`;
if (!existsSync(toolsFile)) {
  const out = spawnSync(process.execPath, [join(here, 'agent-tool.mjs'), '--list'], { encoding: 'utf8', env: { ...process.env, BENCH_CONDITION: condition } });
  writeFileSync(toolsFile, out.stdout);
}
const setup = spawnSync(process.execPath, [join(here, 'harness.mjs'), 'setup', taskId, runId], { encoding: 'utf8' });
if (setup.status !== 0) throw new Error(setup.stderr);
const state = { ...JSON.parse(setup.stdout), condition };
writeFileSync(`${dir}/state.json`, JSON.stringify(state, null, 2));

const fill = text => text.replace(/\{(\w+)\}/g, (m, key) => state[key] ?? m);
const call = `BENCH_CONDITION=${condition} BENCH_LOG=${dir}/calls.jsonl node ${here}/agent-tool.mjs`;

const prompt = `You are an agent that builds and maintains n8n workflows through an MCP server, and you are being evaluated on a task. Work like a careful engineer: correct first, then efficient.

## Tools
The MCP server's tools, with descriptions and input schemas, are listed in ${toolsFile}. Read that file first.
Call a tool with the Bash tool:
  ${call} <tool_name> '<json arguments>'
For long arguments or arguments containing single quotes, write the JSON to a file inside ${dir} and pass @<that file path> instead of the JSON.
The command prints the tool's result. Very long results are saved to a file and the command tells you where; read or search that file.

## Rules
- That command is the only way to read or change n8n. The n8n instance is local and disposable.
- Do not read, search or edit any file on this machine except the tool list, files you create in ${dir}, and result files the command points you to.
- Do not use other MCP tools, the web, or sub-agents.

## Task
${fill(task.prompt)}

## When you are done
Write your final answer as JSON to ${dir}/answer.json with exactly this shape:
${fill(task.answer)}
Then reply with the single word DONE.`;
writeFileSync(`${dir}/prompt.txt`, prompt);
console.log(prompt);
