// Grades a finished run and appends it to the results file.
// Usage: node bench/lens/record.mjs <runId> <agentTokens> <agentToolUses> <durationMs>
// The three numbers come from the agent harness's usage report for that run.
import { readFileSync, appendFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const here = dirname(fileURLToPath(import.meta.url));
const RUNS = 'D:/n8nmcp/bench-runs';
const [runId, tokens, toolUses, durationMs] = process.argv.slice(2);
const dir = `${RUNS}/${runId}`;
const state = JSON.parse(readFileSync(`${dir}/state.json`, 'utf8'));
const grade = spawnSync(process.execPath, [join(here, 'harness.mjs'), 'grade', state.taskId, runId], { encoding: 'utf8' });
if (grade.status !== 0) throw new Error(grade.stderr);
const result = JSON.parse(grade.stdout.trim().split('\n').pop());
const calls = existsSync(`${dir}/calls.jsonl`) ? readFileSync(`${dir}/calls.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const row = {
  runId,
  taskId: state.taskId,
  condition: state.condition,
  model: runId.startsWith('h') ? 'haiku' : 'sonnet',
  success: result.success,
  score: result.score,
  failed: Object.entries(result.checks).filter(([, ok]) => !ok).map(([k]) => k),
  agentTokens: Number(tokens),
  agentToolUses: Number(toolUses),
  durationMs: Number(durationMs),
  mcpCalls: calls.length,
  mcpResultChars: calls.reduce((s, c) => s + c.resultChars, 0),
  mcpArgChars: calls.reduce((s, c) => s + c.argChars, 0),
  spilled: calls.filter(c => c.spilled).length,
  tools: Object.fromEntries([...new Set(calls.map(c => c.tool))].map(t => [t, calls.filter(c => c.tool === t).length])),
};
appendFileSync(`${RUNS}/results.jsonl`, JSON.stringify(row) + '\n');
console.log(JSON.stringify(row));
