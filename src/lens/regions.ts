/**
 * Regions: the units an agent navigates a large workflow by.
 *
 * Sources, in order of trust:
 * 1. Canvas groups (`nodeGroups`, n8n 2.28+): explicit, made by a person.
 * 2. Sticky notes: the smallest note with text whose rectangle contains at least two nodes.
 *    Template authors label sections this way; a note around a single node is an instruction,
 *    not a section.
 * 3. Automatic segmentation for everything left: maximal single-entry, single-exit chains over
 *    `main` edges.
 *
 * Then single-node regions are merged into a neighbor (a trigger joins the stage it starts),
 * oversized ones are split into chains, and AI sub-nodes (models, tools, memory) take the region
 * of the node they serve.
 */

import { WorkflowNode } from '../types/n8n-api';
import { LensGraph, aiRoot, isAiSubNode, mainChildren, mainParents } from './graph';

export type RegionSource = 'group' | 'sticky' | 'auto';

export interface Region {
  /** Stable within one read: R1, R2, ... in data-flow order. */
  id: string;
  name: string;
  source: RegionSource;
  /** Member node names in topological order, AI sub-nodes included. */
  nodes: string[];
}

export interface RegionMap {
  regions: Region[];
  regionOf: Map<string, Region>;
}

const STICKY_DEFAULT_WIDTH = 240;
const STICKY_DEFAULT_HEIGHT = 160;
/** Longest automatic chain. */
const CHAIN_MAX = 12;
/** A sticky or group region with more root nodes than this is split into chains. */
const REGION_MAX = 30;
/** Target block size when splitting an oversized region. */
const CHUNK_TARGET = 15;

interface Draft {
  key: string;
  name: string;
  source: RegionSource;
  /** Part of an oversized sticky or group region that was split into chains. */
  part?: boolean;
}

export function stickyTitle(sticky: WorkflowNode): string {
  const content = String((sticky.parameters as Record<string, unknown>)?.content ?? '');
  for (const raw of content.split('\n')) {
    const line = raw
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[#*_`>~|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (line.length >= 2) return line.length > 60 ? `${line.slice(0, 57)}...` : line;
  }
  return '';
}

function rect(sticky: WorkflowNode): [number, number, number, number] {
  const params = (sticky.parameters ?? {}) as Record<string, unknown>;
  const [sx, sy] = sticky.position ?? [0, 0];
  return [sx, sy, Number(params.width ?? STICKY_DEFAULT_WIDTH), Number(params.height ?? STICKY_DEFAULT_HEIGHT)];
}

function inside(node: WorkflowNode, box: [number, number, number, number]): boolean {
  const [x, y] = node.position ?? [0, 0];
  const [sx, sy, w, h] = box;
  return x >= sx && x <= sx + w && y >= sy && y <= sy + h;
}

export function detectRegions(graph: LensGraph): RegionMap {
  const roots = graph.order.filter(n => !isAiSubNode(graph, n));
  const draftOf = new Map<string, Draft>();

  // 1. Canvas groups.
  const idToName = new Map<string, string>();
  for (const node of graph.nodes.values()) idToName.set(node.id, node.name);
  for (const group of graph.workflow.nodeGroups ?? []) {
    const draft: Draft = { key: `g:${group.id ?? group.name}`, name: group.name, source: 'group' };
    for (const id of group.nodeIds ?? []) {
      const name = idToName.get(id);
      if (name && !draftOf.has(name) && !isAiSubNode(graph, name)) draftOf.set(name, draft);
    }
  }

  // 2. Sticky notes that frame at least two root nodes.
  const frames = graph.stickies
    .map(sticky => ({ sticky, box: rect(sticky), title: stickyTitle(sticky) }))
    .filter(f => f.title)
    .map(f => ({ ...f, members: roots.filter(n => inside(graph.nodes.get(n)!, f.box)) }))
    .filter(f => f.members.length >= 2)
    .sort((a, b) => a.box[2] * a.box[3] - b.box[2] * b.box[3]);
  const frameDraft = new Map<string, Draft>();
  for (const name of roots) {
    if (draftOf.has(name)) continue;
    const frame = frames.find(f => f.members.includes(name));
    if (!frame) continue;
    const key = `s:${frame.sticky.id ?? frame.sticky.name}`;
    if (!frameDraft.has(key)) frameDraft.set(key, { key, name: frame.title, source: 'sticky' });
    draftOf.set(name, frameDraft.get(key)!);
  }

  // 3. Automatic chains over what is left.
  let autoCount = 0;
  const newAuto = (first: string): Draft => ({ key: `a:${++autoCount}`, name: first, source: 'auto' });
  const size = (draft: Draft) => roots.filter(n => draftOf.get(n) === draft).length;
  for (const name of roots) {
    if (draftOf.has(name)) continue;
    const parents = mainParents(graph, name).filter(e => e.from !== name);
    const parent = parents.length === 1 ? parents[0].from : undefined;
    const parentDraft = parent ? draftOf.get(parent) : undefined;
    const continues = parentDraft?.source === 'auto' && mainChildren(graph, parent!).length === 1 && size(parentDraft) < CHAIN_MAX;
    draftOf.set(name, continues ? parentDraft! : newAuto(name));
  }

  // Merge single-node regions into a neighbor: the stage they feed, else the stage feeding them.
  const mergeSingles = () => {
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      for (const name of roots) {
        const draft = draftOf.get(name)!;
        if (draft.source === 'group' || size(draft) > 1) continue;
        const neighbor =
          mainChildren(graph, name).map(e => draftOf.get(e.to)).find(d => d && d !== draft && size(d) < REGION_MAX) ??
          mainParents(graph, name).map(e => draftOf.get(e.from)).find(d => d && d !== draft && size(d) < REGION_MAX);
        if (!neighbor) continue;
        draftOf.set(name, neighbor);
        changed = true;
      }
      if (!changed) break;
    }
  };
  mergeSingles();

  // Split oversized regions into even, contiguous blocks of the topological order. Contiguity keeps
  // parallel sibling branches together, which chain splitting would shatter into single nodes.
  const oversized = [...new Set(draftOf.values())].filter(d => size(d) > REGION_MAX);
  for (const big of oversized) {
    const members = roots.filter(n => draftOf.get(n) === big);
    const blocks = Math.ceil(members.length / CHUNK_TARGET);
    const per = Math.ceil(members.length / blocks);
    const parts: Draft[] = [];
    members.forEach((name, index) => {
      const part = Math.floor(index / per);
      parts[part] ??= { key: `${big.key}#${part}`, name: big.name, source: big.source, part: true };
      draftOf.set(name, parts[part]);
    });
  }
  mergeSingles();

  // AI sub-nodes join the region of the node they serve.
  for (const name of graph.order) {
    if (!isAiSubNode(graph, name)) continue;
    const root = aiRoot(graph, name);
    draftOf.set(name, draftOf.get(root) ?? newAuto(root));
  }

  const regions: Region[] = [];
  const parts = new Set<Region>();
  const byDraft = new Map<Draft, Region>();
  const regionOf = new Map<string, Region>();
  for (const name of graph.order) {
    const draft = draftOf.get(name)!;
    let region = byDraft.get(draft);
    if (!region) {
      region = { id: `R${regions.length + 1}`, name: draft.name, source: draft.source, nodes: [] };
      byDraft.set(draft, region);
      regions.push(region);
      if (draft.part) parts.add(region);
    }
    region.nodes.push(name);
    regionOf.set(name, region);
  }

  // Automatic regions, and the parts of split ones, are named after their span.
  for (const region of regions) {
    if (region.source !== 'auto' && !parts.has(region)) continue;
    const members = region.nodes.filter(n => !isAiSubNode(graph, n));
    const first = members[0] ?? region.nodes[0];
    const last = members[members.length - 1];
    const span = last && last !== first ? `${first} .. ${last}` : first;
    region.name = region.source === 'auto' ? span : `${region.name} / ${span}`;
  }

  return { regions, regionOf };
}
