// Renders a workflow's canvas positions to a standalone HTML file, roughly as the n8n editor
// draws them, to review layouts without opening n8n. Usage: node render-canvas.mjs <workflowId> <out.html>
import { readFileSync, writeFileSync } from 'fs';

const env = Object.fromEntries(readFileSync('D:/n8nmcp/testbed/testbed.env', 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const [id, out] = process.argv.slice(2);
const wf = await (await fetch(`${env.N8N_TESTBED_URL}/api/v1/workflows/${id}`, { headers: { 'X-N8N-API-KEY': env.N8N_API_KEY } })).json();
const sub = new Set(Object.entries(wf.connections).filter(([, c]) => Object.keys(c).some(k => k !== 'main')).map(([n]) => n));
const SIZE = 100, SUB = 70;
const box = n => (sub.has(n.name) ? { w: SUB, h: SUB } : { w: SIZE, h: SIZE });
const pos = Object.fromEntries(wf.nodes.map(n => [n.name, n]));
const xs = wf.nodes.map(n => n.position[0]), ys = wf.nodes.map(n => n.position[1]);
const minX = Math.min(...xs) - 80, minY = Math.min(...ys) - 80, W = Math.max(...xs) - minX + 260, H = Math.max(...ys) - minY + 220;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
let edges = '';
for (const [from, byType] of Object.entries(wf.connections)) {
  for (const [type, outs] of Object.entries(byType)) {
    outs.forEach((targets, o) => (targets ?? []).forEach(t => {
      const a = pos[from], b = pos[t.node];
      if (!a || !b) return;
      const ba = box(a), bb = box(b);
      if (type === 'main') {
        const x1 = a.position[0] + ba.w - minX, y1 = a.position[1] + ba.h / 2 - minY + (outs.length > 1 ? (o - (outs.length - 1) / 2) * 24 : 0);
        const x2 = b.position[0] - minX, y2 = b.position[1] + bb.h / 2 - minY;
        edges += `<path d="M${x1},${y1} C${x1 + 60},${y1} ${x2 - 60},${y2} ${x2},${y2}" class="e"/>`;
      } else {
        const x1 = a.position[0] + ba.w / 2 - minX, y1 = a.position[1] - minY;
        const x2 = b.position[0] + bb.w / 2 - minX, y2 = b.position[1] + bb.h - minY;
        edges += `<path d="M${x1},${y1} L${x2},${y2}" class="e ai"/>`;
      }
    }));
  }
}
const nodes = wf.nodes.map(n => {
  const { w, h } = box(n), x = n.position[0] - minX, y = n.position[1] - minY;
  const shape = sub.has(n.name) ? `<circle cx="${x + w / 2}" cy="${y + h / 2}" r="${w / 2}" class="n s"/>` : `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" class="n"/>`;
  return `${shape}<text x="${x + w / 2}" y="${y + h + 16}" class="t">${esc(n.name)}</text><text x="${x + w / 2}" y="${y + h / 2 + 4}" class="k">${esc(n.type.split('.').pop())}</text>`;
}).join('');
writeFileSync(out, `<!doctype html><meta charset="utf-8"><title>${esc(wf.name)}</title><style>body{margin:0;background:#f5f5f7;font:12px system-ui}svg{display:block}.n{fill:#fff;stroke:#9aa0a6;stroke-width:1.5}.s{fill:#eef3ff}.e{fill:none;stroke:#7a7f87;stroke-width:1.5}.ai{stroke-dasharray:4 3;stroke:#8b6fd6}.t{text-anchor:middle;fill:#222}.k{text-anchor:middle;fill:#888;font-size:10px}</style><svg viewBox="0 0 ${W} ${H}" width="100%">${edges}${nodes}</svg>`);
console.log(out);
