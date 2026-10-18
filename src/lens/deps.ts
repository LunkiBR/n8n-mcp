/**
 * Data dependencies between nodes: what a node reads, where each field comes from, and who
 * reads the node's own output.
 *
 * This is what keeps a zoom honest. A zoomed node's expressions can read any earlier node, and
 * `$json` fields are often produced several hops upstream and passed through. The zoom lists
 * those sources whether or not they are inside the zoom.
 */

import { WorkflowNode } from '../types/n8n-api';
import { LensGraph, mainChildren, mainParents } from './graph';
import { ExprRef, extractNodeRefs } from './refs';
import { NodeOutput } from './schema';
import { shortType } from './summary';

export interface Read {
  /** Source node. */
  node: string;
  via: 'input' | 'name';
  /** Fields read from that source; empty when the whole item is read. */
  fields: string[];
}

export interface FieldOrigin {
  field: string;
  /** Node that produces the field, when known. */
  origin?: string;
  basis: 'execution' | 'static' | 'unknown';
  /** True when run data shows the direct input does not contain the field. */
  missing?: boolean;
}

export interface Reader {
  node: string;
  via: 'input' | 'name';
  fields: string[];
}

export class DependencyIndex {
  private readonly refs = new Map<string, ExprRef[]>();

  constructor(private readonly graph: LensGraph, private readonly outputs: Map<string, NodeOutput>) {
    for (const [name, node] of graph.nodes) this.refs.set(name, extractNodeRefs(node));
  }

  refsOf(name: string): ExprRef[] {
    return this.refs.get(name) ?? [];
  }

  reads(name: string): Read[] {
    const reads = new Map<string, Read>();
    const add = (node: string, via: Read['via'], field?: string) => {
      const key = `${via}:${node}`;
      const read = reads.get(key) ?? { node, via, fields: [] };
      if (field && !read.fields.includes(field)) read.fields.push(field);
      reads.set(key, read);
    };
    const parents = mainParents(this.graph, name).map(e => e.from);
    for (const ref of this.refsOf(name)) {
      if (ref.node !== undefined) add(ref.node, 'name', ref.field);
      else for (const parent of parents) add(parent, 'input', ref.field);
    }
    // A node always consumes its main input, even when no expression names a field.
    for (const parent of parents) add(parent, 'input');
    return [...reads.values()];
  }

  readers(name: string): Reader[] {
    const readers: Reader[] = [];
    for (const [other, refs] of this.refs) {
      if (other === name) continue;
      const fields = refs.filter(r => r.node === name).map(r => r.field).filter((f): f is string => !!f);
      if (refs.some(r => r.node === name)) readers.push({ node: other, via: 'name', fields: [...new Set(fields)] });
    }
    for (const edge of mainChildren(this.graph, name)) {
      const fields = this.refsOf(edge.to).filter(r => r.node === undefined && r.field).map(r => r.field!);
      readers.push({ node: edge.to, via: 'input', fields: [...new Set(fields)] });
    }
    return readers;
  }

  /** Where a `$json` field read by `name` comes from. */
  originOf(name: string, field: string): FieldOrigin {
    const top = field.split('.')[0].replace(/\[\d+\]$/, '');
    const parent = mainParents(this.graph, name)[0]?.from;
    if (!parent) return { field, basis: 'unknown' };

    const has = (node: string) => {
      const fields = this.outputs.get(node)?.fields;
      if (!fields) return undefined;
      return fields.has(field) || fields.has(top);
    };

    const parentHas = has(parent);
    if (parentHas === false) return { field, origin: undefined, basis: 'execution', missing: true };
    if (parentHas === true) {
      // Walk up while the field is passed through unchanged; the origin is where it first appears.
      let current = parent;
      for (let hop = 0; hop < 30; hop++) {
        const up = mainParents(this.graph, current)[0]?.from;
        if (!up || has(up) !== true) break;
        current = up;
      }
      return { field, origin: current, basis: 'execution' };
    }

    // No run data: look for a node that statically writes the field.
    let current: string | undefined = parent;
    for (let hop = 0; current && hop < 30; hop++) {
      if (writesField(this.graph.nodes.get(current), top)) return { field, origin: current, basis: 'static' };
      current = mainParents(this.graph, current)[0]?.from;
    }
    return { field, basis: 'unknown' };
  }
}

function writesField(node: WorkflowNode | undefined, field: string): boolean {
  if (!node) return false;
  const p = (node.parameters ?? {}) as Record<string, any>;
  const type = shortType(node.type);
  if (type === 'set') {
    const assignments = p.assignments?.assignments;
    if (Array.isArray(assignments) && assignments.some((a: any) => a?.name === field || String(a?.name ?? '').startsWith(`${field}.`))) return true;
    const values = p.values ? Object.values(p.values).flat() : [];
    if (values.some((v: any) => v?.name === field)) return true;
    if (typeof p.jsonOutput === 'string' && p.jsonOutput.includes(`"${field}"`)) return true;
    return false;
  }
  if (type === 'code' || type === 'function' || type === 'functionItem') {
    const code = String(p.jsCode ?? p.pythonCode ?? p.functionCode ?? '');
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(String.raw`(?:[{,]\s*['"]?${escaped}['"]?\s*:)|(?:\.${escaped}\s*=[^=])|(?:\[['"]${escaped}['"]\]\s*=[^=])`).test(code);
  }
  return false;
}
