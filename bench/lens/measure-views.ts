/**
 * Measures lens view sizes on the fixture workflows against the raw JSON that
 * n8n_get_workflow(full) returns. Run: npx vite-node bench/lens/measure-views.ts
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { createLensContext, inspect } from '../../src/lens';

const dir = join(__dirname, 'fixtures');
const tok = (s: string) => Math.ceil(s.length / 3.6);
const rows: string[] = [];
for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
  const wf = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  wf.id = file.replace('.json', '');
  const ctx = createLensContext(wf);
  const raw = JSON.stringify(wf, null, 2);
  const structure = JSON.stringify({ nodes: wf.nodes.map((n: any) => ({ id: n.id, name: n.name, type: n.type, position: n.position, disabled: !!n.disabled })), connections: wf.connections }, null, 2);
  const overview = inspect(wf, { view: 'overview' });
  const outline = inspect(wf, { view: 'outline' });
  const biggest = [...ctx.regions.regions].sort((a, b) => b.nodes.length - a.nodes.length)[0];
  const zoom = inspect(wf, { view: 'zoom', region: biggest.id });
  rows.push([file, wf.nodes.length, ctx.regions.regions.length, tok(raw), tok(structure), tok(overview), tok(outline), `${tok(zoom)} (${biggest.id}, ${biggest.nodes.length} nodes)`].join(' | '));
}
console.log('fixture | nodes | regions | full JSON | structure | overview | outline | zoom biggest region');
console.log(rows.join('\n'));
