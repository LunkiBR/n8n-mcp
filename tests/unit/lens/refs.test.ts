import { describe, it, expect } from 'vitest';
import { extractNodeRefs, extractRefsFromString, normalizeFieldChain } from '@/lens/refs';

describe('lens refs', () => {
  it('reads explicit node references with their field paths', () => {
    const refs = extractRefsFromString("={{ $('Set Config').item.json.api.base }}/v1/{{ $(\"Lookup\").first().json[\"customer id\"] }}", 'url', false);
    expect(refs).toEqual(
      expect.arrayContaining([
        { node: 'Set Config', field: 'api.base', at: 'url' },
        { node: 'Lookup', field: 'customer id', at: 'url' },
      ])
    );
  });

  it('reads legacy $node and $items references', () => {
    const refs = extractRefsFromString('={{ $node["Old Node"].json.total }} {{ $node.Other.json.x }} {{ $items("Batch")[0] }}', 'p', false);
    expect(refs.map(r => `${r.node}:${r.field ?? ''}`)).toEqual(expect.arrayContaining(['Old Node:total', 'Other:x', 'Batch:']));
  });

  it('reads implicit input fields', () => {
    const refs = extractRefsFromString('={{ $json.score > 7 && $json["tier"] === $input.first().json.plan }}', 'cond', false);
    expect(refs.filter(r => !r.node).map(r => r.field)).toEqual(['score', 'tier', 'plan']);
  });

  it('ignores plain strings that are not expressions', () => {
    expect(extractRefsFromString("$('Not An Expression').item.json.x", 'p', false)).toEqual([]);
  });

  it('scans code fields as code', () => {
    const node = {
      id: '1', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [0, 0] as [number, number],
      parameters: { jsCode: "const cfg = $('Set Config').first().json;\nreturn items.map(item => ({ json: { v: item.json.value, t: items[0].json.total } }));" },
    };
    const refs = extractNodeRefs(node);
    expect(refs.map(r => `${r.node ?? '$input'}:${r.field ?? ''}`)).toEqual(
      expect.arrayContaining(['Set Config:', '$input:value', '$input:total'])
    );
  });

  it('keeps node names with escaped quotes', () => {
    const refs = extractRefsFromString("={{ $('Bob\\'s Node').item.json.a }}", 'p', false);
    expect(refs[0]).toEqual({ node: "Bob's Node", field: 'a', at: 'p' });
  });

  it('normalizes field chains', () => {
    expect(normalizeFieldChain('.a["b c"][0].d')).toBe('a.b c[0].d');
    expect(normalizeFieldChain('')).toBeUndefined();
  });
});

describe('lens refs in code', () => {
  const code = (jsCode: string) => ({ id: '1', name: 'C', type: 'n8n-nodes-base.code', typeVersion: 2, position: [0, 0] as [number, number], parameters: { jsCode } });

  it('reads fields through callback and loop variables bound to input items', () => {
    const refs = extractNodeRefs(code("return $input.all().map(i => ({ json: { tax: i.json.amount * 0.2 } }));\nfor (const row of items) { row.json.total; }"));
    expect(refs.filter(r => !r.node).map(r => r.field)).toEqual(expect.arrayContaining(['amount', 'total']));
  });

  it('does not treat callbacks over a node read by name as input reads', () => {
    const refs = extractNodeRefs(code("return $('Lookup').all().map(o => ({ json: { id: o.json.id } }));"));
    expect(refs).toEqual([{ node: 'Lookup', field: undefined, at: 'jsCode' }]);
  });
});
