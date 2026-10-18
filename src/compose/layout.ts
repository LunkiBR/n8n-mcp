/**
 * Canvas positions for composed workflows, so people can read what agents build.
 *
 * New workflows get a layered left-to-right layout: each node sits one column right of its
 * furthest main-input parent, nodes in a column are ordered by their parents' rows to reduce
 * crossings, and AI sub-nodes sit below the node they serve. When extending a workflow, nodes a
 * person placed are never moved; new nodes are placed next to a connected neighbor in a free slot.
 */

import { FlowEdge } from './notation';

export type Position = [number, number];

const COL = 260;
const ROW = 180;
const SUB_ROW = 200;
const SUB_COL = 140;
const ORIGIN: Position = [0, 0];

interface LayoutInput {
  names: string[];
  edges: FlowEdge[];
}

function aiTargets(edges: FlowEdge[], name: string): string | undefined {
  return edges.find(e => e.from === name && e.type !== 'main')?.to;
}

function isSubNode(edges: FlowEdge[], name: string): boolean {
  return edges.some(e => e.from === name && e.type !== 'main') && !edges.some(e => e.type === 'main' && (e.from === name || e.to === name));
}

/** Layered layout for a whole new workflow. */
export function layoutWorkflow({ names, edges }: LayoutInput): Map<string, Position> {
  const main = edges.filter(e => e.type === 'main');
  const roots = names.filter(n => !isSubNode(edges, n));

  // Back edges close cycles (SplitInBatches loops). Find them by walking forward from where data
  // enters, so the edge that returns to the loop node is the one dropped, not the one entering it.
  const back = new Set<FlowEdge>();
  const walk = new Map<string, 'open' | 'closed'>();
  const visit = (name: string) => {
    walk.set(name, 'open');
    for (const edge of main.filter(e => e.from === name)) {
      const state = walk.get(edge.to);
      if (state === 'open') back.add(edge);
      else if (state === undefined) visit(edge.to);
    }
    walk.set(name, 'closed');
  };
  const sources = roots.filter(n => !main.some(e => e.to === n));
  for (const name of [...sources, ...roots]) if (!walk.has(name)) visit(name);
  const forward = main.filter(e => !back.has(e));

  // Longest-path layering over the remaining acyclic edges.
  const layer = new Map<string, number>();
  const depth = (name: string): number => {
    if (layer.has(name)) return layer.get(name)!;
    layer.set(name, 0);
    const parents = forward.filter(e => e.to === name);
    const value = parents.length ? Math.max(...parents.map(e => depth(e.from) + 1)) : 0;
    layer.set(name, value);
    return value;
  };
  roots.forEach(depth);

  const columns = new Map<number, string[]>();
  for (const name of roots) {
    const column = columns.get(layer.get(name)!) ?? [];
    column.push(name);
    columns.set(layer.get(name)!, column);
  }

  const row = new Map<string, number>();
  for (const index of [...columns.keys()].sort((a, b) => a - b)) {
    const column = columns.get(index)!;
    const weight = (name: string) => {
      const parents = forward.filter(e => e.to === name && row.has(e.from));
      if (parents.length === 0) return Number.MAX_SAFE_INTEGER;
      return parents.reduce((sum, e) => sum + row.get(e.from)! + e.output * 0.01, 0) / parents.length;
    };
    column.sort((a, b) => weight(a) - weight(b));
    // Whole-number rows keep every row's AI sub-nodes clear of the next row.
    column.forEach((name, i) => row.set(name, i - Math.floor((column.length - 1) / 2)));
  }

  // Rows need room for the AI sub-nodes hanging below their agents.
  const rowSpacing = edges.some(e => e.type !== 'main') ? ROW * 2 : ROW;
  const positions = new Map<string, Position>();
  for (const name of roots) {
    positions.set(name, [ORIGIN[0] + layer.get(name)! * COL, Math.round(ORIGIN[1] + row.get(name)! * rowSpacing)]);
  }
  placeSubNodes(names, edges, positions);
  return positions;
}

function placeSubNodes(names: string[], edges: FlowEdge[], positions: Map<string, Position>) {
  // Sub-nodes of sub-nodes (embeddings under a vector store) are placed after their parent.
  for (let pass = 0; pass < 4; pass++) {
    for (const name of names) {
      if (positions.has(name) || !isSubNode(edges, name)) continue;
      const target = aiTargets(edges, name)!;
      const anchor = positions.get(target);
      if (!anchor) continue;
      const siblings = edges.filter(e => e.to === target && e.type !== 'main').map(e => e.from);
      const index = siblings.indexOf(name);
      positions.set(name, [anchor[0] + (index - (siblings.length - 1) / 2) * SUB_COL, anchor[1] + SUB_ROW]);
    }
  }
  for (const name of names) if (!positions.has(name)) positions.set(name, [ORIGIN[0], ORIGIN[1] + 3 * ROW]);
}

/**
 * Positions for nodes added to an existing workflow. Existing positions are kept as-is; each new
 * node goes right of its main parent (or left of its main child, or below the node it serves)
 * in the first slot not already taken.
 */
export function placeNewNodes(newNames: string[], edges: FlowEdge[], existing: Map<string, Position>): Map<string, Position> {
  const taken = [...existing.values()];
  const placed = new Map<string, Position>();
  const free = ([x, y]: Position, step: number): Position => {
    let candidate: Position = [x, y];
    for (let i = 0; i < 50; i++) {
      if (!taken.some(([tx, ty]) => Math.abs(tx - candidate[0]) < COL * 0.6 && Math.abs(ty - candidate[1]) < ROW * 0.6)) break;
      candidate = [x, y + step * (i + 1)];
    }
    taken.push(candidate);
    return candidate;
  };
  const positionOf = (name: string) => existing.get(name) ?? placed.get(name);
  const maxX = Math.max(ORIGIN[0], ...taken.map(([x]) => x));

  for (let pass = 0; pass < newNames.length + 1; pass++) {
    for (const name of newNames) {
      if (placed.has(name)) continue;
      const parent = edges.find(e => e.type === 'main' && e.to === name && positionOf(e.from));
      const child = edges.find(e => e.type === 'main' && e.from === name && positionOf(e.to));
      const served = edges.find(e => e.type !== 'main' && e.from === name && positionOf(e.to));
      let anchor: Position | undefined;
      if (served) anchor = [positionOf(served.to)![0], positionOf(served.to)![1] + SUB_ROW];
      else if (parent) anchor = [positionOf(parent.from)![0] + COL, positionOf(parent.from)![1]];
      else if (child) anchor = [positionOf(child.to)![0] - COL, positionOf(child.to)![1]];
      if (anchor) placed.set(name, free(anchor, served ? SUB_COL / 2 : ROW));
    }
  }
  // Nodes connected to nothing placed yet go in a new column to the right.
  newNames.filter(n => !placed.has(n)).forEach((name, i) => placed.set(name, free([maxX + COL, ORIGIN[1] + i * ROW], ROW)));
  return placed;
}
