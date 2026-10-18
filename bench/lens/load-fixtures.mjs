// Creates every fixture workflow on the n8n instance in N8N_API_URL / N8N_API_KEY and prints
// a JSON map fixture -> workflow id. Usage: node bench/lens/load-fixtures.mjs > bench/lens/.fixture-ids.json
import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const base = process.env.N8N_API_URL.replace(/\/$/, '');
const headers = { 'X-N8N-API-KEY': process.env.N8N_API_KEY, 'content-type': 'application/json' };
const ids = {};
for (const file of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
  const fx = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const body = { name: `[fixture] ${fx.name}`.slice(0, 128), nodes: fx.nodes, connections: fx.connections, settings: { executionOrder: 'v1' } };
  const res = await fetch(`${base}/workflows`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) { console.error(`${file}: ${res.status} ${text.slice(0, 300)}`); continue; }
  ids[file.replace('.json', '')] = JSON.parse(text).id;
}
console.log(JSON.stringify(ids, null, 2));
