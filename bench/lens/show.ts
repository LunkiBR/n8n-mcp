/** Prints one lens view of a fixture. Usage: npx vite-node bench/lens/show.ts <fixture> <view> [region|node,node|query] */
import { readFileSync } from 'fs';
import { join } from 'path';
import { inspect, LensView } from '../../src/lens';

const [file, view, arg] = process.argv.slice(2);
const wf = JSON.parse(readFileSync(join(__dirname, 'fixtures', file), 'utf8'));
wf.id = file.replace('.json', '');
const opts: any = { view: view as LensView };
if (view === 'find') opts.query = arg;
else if (arg && /^R\d+$/.test(arg)) opts.region = arg;
else if (arg) opts.nodes = arg.split(',');
console.log(inspect(wf, opts));
