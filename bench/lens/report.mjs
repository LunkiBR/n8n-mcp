// Summarizes results.jsonl per task and condition as a Markdown table.
// Usage: node bench/lens/report.mjs [results.jsonl] [--exclude-prefix pilot-]
import { readFileSync } from 'fs';

const file = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'D:/n8nmcp/bench-runs/results.jsonl';
const exclude = process.argv.includes('--exclude-prefix') ? process.argv[process.argv.indexOf('--exclude-prefix') + 1] : 'pilot-';
const rows = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => !r.runId.startsWith(exclude))
  .map(r => ({ ...r, condition: `${r.condition}/${r.model ?? 'sonnet'}` }));

const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const k = n => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

const groups = new Map();
for (const r of rows) {
  const key = `${r.taskId}|${r.condition}`;
  groups.set(key, [...(groups.get(key) ?? []), r]);
}
const tasks = [...new Set(rows.map(r => r.taskId))];
const conditions = [...new Set(rows.map(r => r.condition))].sort();
const lines = ['| task | condition | runs | success | mean score | median agent tokens | median MCP result chars | median calls | median minutes |', '|---|---|---|---|---|---|---|---|---|'];
for (const task of tasks) {
  for (const condition of conditions) {
    const g = groups.get(`${task}|${condition}`);
    if (!g) continue;
    lines.push(`| ${task} | ${condition} | ${g.length} | ${g.filter(r => r.success).length}/${g.length} | ${(g.reduce((s, r) => s + r.score, 0) / g.length).toFixed(2)} | ${k(median(g.map(r => r.agentTokens)))} | ${k(median(g.map(r => r.mcpResultChars)))} | ${median(g.map(r => r.mcpCalls))} | ${(median(g.map(r => r.durationMs)) / 60000).toFixed(1)} |`);
  }
}
const total = c => rows.filter(r => r.condition === c);
lines.push('', '| condition | runs | success | total agent tokens | total MCP result chars |', '|---|---|---|---|---|');
for (const c of conditions) {
  const g = total(c);
  lines.push(`| ${c} | ${g.length} | ${g.filter(r => r.success).length}/${g.length} | ${k(g.reduce((s, r) => s + r.agentTokens, 0))} | ${k(g.reduce((s, r) => s + r.mcpResultChars, 0))} |`);
}
console.log(lines.join('\n'));
