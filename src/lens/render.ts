/**
 * Text renderings of a workflow at four levels of detail.
 *
 * - overview: regions and how they connect; size grows with the number of regions, not nodes
 * - outline:  one line per node with its edges; whole workflow or one region
 * - zoom:     full parameters of chosen nodes plus everything they read and who reads them
 * - find:     where a text occurs in names, parameters and expressions
 *
 * Output is plain text meant to be read by an agent. Node names are the only identifiers, as in
 * every n8n edit operation.
 */

import { WorkflowNode } from '../types/n8n-api';
import { LensGraph, aiInputs, isAiSubNode, mainChildren, mainParents } from './graph';
import { Region, RegionMap } from './regions';
import { DependencyIndex } from './deps';
import { NodeOutput, formatFields } from './schema';
import { clip, shortType, summarizeNode } from './summary';

export interface LensContext {
  graph: LensGraph;
  regions: RegionMap;
  deps: DependencyIndex;
  outputs: Map<string, NodeOutput>;
  /** Where `outputs` came from, e.g. `execution 812 (success)`. */
  outputsLabel?: string;
}

/** Rough token count used to tell the agent what a view will cost before asking for it. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

// ---------------------------------------------------------------------------------------------
// Edges

function baseOutputCount(node: WorkflowNode): number {
  const type = shortType(node.type);
  const p = (node.parameters ?? {}) as Record<string, any>;
  if (type === 'if' || type === 'filter' || type === 'splitInBatches' || type === 'compareDatasets') return 2;
  if (type === 'switch') {
    const rules = p.rules?.values ?? p.rules?.rules;
    const count = Array.isArray(rules) ? rules.length : Number(p.numberOutputs ?? 4);
    return count + (p.options?.fallbackOutput === 'extra' ? 1 : 0);
  }
  return 1;
}

/** Label for an output port, as used in the authoring notation (`If.true`, `Loop.done`, `Switch.2`). */
export function outputLabel(node: WorkflowNode, output: number): string {
  const type = shortType(node.type);
  const p = (node.parameters ?? {}) as Record<string, any>;
  if (node.onError === 'continueErrorOutput' && output >= baseOutputCount(node)) return 'error';
  if (type === 'if') return output === 0 ? 'true' : 'false';
  if (type === 'filter') return output === 0 ? 'kept' : 'discarded';
  if (type === 'splitInBatches' && (node.typeVersion ?? 1) >= 3) return output === 0 ? 'done' : 'loop';
  if (type === 'switch') {
    const rules = p.rules?.values ?? p.rules?.rules;
    const key = Array.isArray(rules) ? rules[output]?.outputKey : undefined;
    if (typeof key === 'string' && key && !/[\s.]/.test(key)) return key;
  }
  return String(output);
}

/** Short aliases for AI ports, shared with the authoring notation. */
export const AI_PORT_ALIASES: Record<string, string> = {
  ai_languageModel: 'model',
  ai_tool: 'tool',
  ai_memory: 'memory',
  ai_outputParser: 'parser',
  ai_embedding: 'embedding',
  ai_retriever: 'retriever',
  ai_vectorStore: 'vectorStore',
  ai_document: 'document',
  ai_textSplitter: 'textSplitter',
  ai_reranker: 'reranker',
};

function regionTag(ctx: LensContext, name: string, here?: Region): string {
  if (ctx.regions.regions.length < 2) return '';
  const region = ctx.regions.regionOf.get(name);
  return region && region !== here ? ` [${region.id}]` : '';
}

function edgesText(ctx: LensContext, name: string, here?: Region): string {
  const node = ctx.graph.nodes.get(name)!;
  const byOutput = new Map<number, string[]>();
  for (const edge of mainChildren(ctx.graph, name)) {
    const targets = byOutput.get(edge.output) ?? [];
    const input = edge.input > 0 ? `.${edge.input}` : '';
    targets.push(`${edge.to}${input}${regionTag(ctx, edge.to, here)}`);
    byOutput.set(edge.output, targets);
  }
  if (byOutput.size === 0) return '';
  const single = byOutput.size === 1 && byOutput.has(0) && baseOutputCount(node) === 1 && node.onError !== 'continueErrorOutput';
  if (single) return ` -> ${byOutput.get(0)!.join(', ')}`;
  return ' ' + [...byOutput.entries()]
    .sort(([a], [b]) => a - b)
    .map(([output, targets]) => `${outputLabel(node, output)}-> ${targets.join(', ')}`)
    .join('; ');
}

function aiText(ctx: LensContext, name: string): string {
  const groups = new Map<string, string[]>();
  for (const edge of aiInputs(ctx.graph, name)) {
    const port = AI_PORT_ALIASES[edge.type] ?? edge.type;
    const sub = ctx.graph.nodes.get(edge.from)!;
    const summary = summarizeNode(sub);
    const nested = aiInputs(ctx.graph, edge.from).length > 0 ? ` {${aiText(ctx, edge.from)}}` : '';
    const list = groups.get(port) ?? [];
    list.push(`${edge.from}${summary ? ` (${clip(summary, 40)})` : ''}${nested}`);
    groups.set(port, list);
  }
  return [...groups.entries()].map(([port, subs]) => `${port}: ${subs.join(', ')}`).join('; ');
}

function nodeHead(node: WorkflowNode): string {
  const off = node.disabled ? ' OFF' : '';
  return `${node.name} (${shortType(node.type)} v${node.typeVersion ?? 1}${off})`;
}

// ---------------------------------------------------------------------------------------------
// Views

export function renderOutlineLines(ctx: LensContext, names: string[], here?: Region): string[] {
  const lines: string[] = [];
  for (const name of names) {
    if (isAiSubNode(ctx.graph, name)) continue;
    const node = ctx.graph.nodes.get(name)!;
    const summary = summarizeNode(node);
    const fromOutside = here
      ? mainParents(ctx.graph, name).filter(e => ctx.regions.regionOf.get(e.from) !== here).map(e => `${e.from}${regionTag(ctx, e.from, here)}`)
      : [];
    const entry = fromOutside.length ? ` <- ${fromOutside.join(', ')}` : '';
    lines.push(`- ${nodeHead(node)}${summary ? `: ${summary}` : ''}${entry}${edgesText(ctx, name, here)}`);
    const ai = aiText(ctx, name);
    if (ai) lines.push(`    ${ai}`);
  }
  return lines;
}

function regionLinks(ctx: LensContext, region: Region): { entries: string[]; next: string[] } {
  const entries = new Set<string>();
  const next = new Set<string>();
  for (const name of region.nodes) {
    const parents = mainParents(ctx.graph, name);
    if (parents.length === 0 && !isAiSubNode(ctx.graph, name)) entries.add(name);
    for (const edge of parents) if (ctx.regions.regionOf.get(edge.from) !== region) entries.add(name);
    for (const edge of mainChildren(ctx.graph, name)) {
      const target = ctx.regions.regionOf.get(edge.to);
      if (target && target !== region) next.add(target.id);
    }
  }
  return { entries: [...entries], next: [...next] };
}

export function renderOverview(ctx: LensContext, inlineOutlineBelow = 25): string {
  const { graph, regions } = ctx;
  const wf = graph.workflow;
  const executable = graph.nodes.size;
  const lines: string[] = [];
  lines.push(`workflow "${wf.name}" id=${wf.id ?? '?'} active=${wf.active ? 'yes' : 'no'} nodes=${executable}${graph.stickies.length ? ` (+${graph.stickies.length} sticky notes)` : ''} regions=${regions.regions.length}`);
  if (graph.triggers.length) {
    lines.push(`triggers: ${graph.triggers.map(t => `${t} (${summarizeNode(graph.nodes.get(t)!) || shortType(graph.nodes.get(t)!.type)})${regionTag(ctx, t)}`).join('; ')}`);
  }

  if (executable <= inlineOutlineBelow) {
    lines.push('', ...renderOutlineLines(ctx, graph.order));
  } else {
    lines.push('', 'regions:');
    for (const region of regions.regions) {
      const { entries, next } = regionLinks(ctx, region);
      const zoomCost = estimateTokens(renderZoom(ctx, region.nodes, { full: false }));
      const agents = region.nodes.filter(n => aiInputs(graph, n).length > 0);
      const parts = [
        `${region.id} ${clip(region.name, 80)}`,
        `${region.nodes.length} nodes`,
        `zoom~${formatTokens(zoomCost)}tok`,
        entries.length ? `in: ${clip(entries.join(', '), 70)}` : '',
        agents.length ? `ai: ${clip(agents.join(', '), 50)}` : '',
        next.length ? `-> ${next.join(', ')}` : '',
      ].filter(Boolean);
      lines.push(parts.join(' | '));
    }
  }

  const disabled = [...graph.nodes.values()].filter(n => n.disabled).map(n => n.name);
  const unreachable = [...graph.nodes.keys()].filter(n =>
    !graph.triggers.includes(n) && !isAiSubNode(graph, n) && mainParents(graph, n).length === 0);
  const issues: string[] = [];
  if (disabled.length) issues.push(`disabled: ${clip(disabled.join(', '), 120)}`);
  if (unreachable.length) issues.push(`no input: ${clip(unreachable.join(', '), 120)}`);
  if (issues.length) lines.push('', `issues: ${issues.join(' | ')}`);

  if (executable > inlineOutlineBelow) {
    const outlineCost = estimateTokens(renderOutlineLines(ctx, graph.order).join('\n'));
    lines.push('', `next: view=outline region=<id> (one line per node; whole workflow ~${formatTokens(outlineCost)}tok) | view=zoom nodes=[...] or region=<id> | view=find query=<text>`);
  } else {
    lines.push('', 'next: view=zoom nodes=[...] for parameters and data dependencies | view=find query=<text>');
  }
  return lines.join('\n');
}

export function renderOutline(ctx: LensContext, region?: Region): string {
  const names = region ? region.nodes : ctx.graph.order;
  const header = region
    ? `${region.id} ${region.name} (${region.source}, ${region.nodes.length} nodes)`
    : `workflow "${ctx.graph.workflow.name}" ${ctx.graph.nodes.size} nodes`;
  return [header, ...renderOutlineLines(ctx, names, region)].join('\n');
}

// ---------------------------------------------------------------------------------------------
// Parameters

interface EmitOptions {
  full: boolean;
}

const SKIP_KEYS = new Set(['__rl']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function emitString(key: string, value: string, indent: string, lines: string[], limit: number) {
  const text = value.length > limit ? `${value.slice(0, limit)}... [+${value.length - limit} chars, view=zoom full=true]` : value;
  if (text.includes('\n')) {
    lines.push(`${indent}${key}: |`);
    for (const line of text.split('\n')) lines.push(`${indent}  ${line}`);
  } else {
    lines.push(`${indent}${key}: ${text}`);
  }
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

function emitValue(key: string, value: unknown, indent: string, lines: string[], opts: EmitOptions, codeKey: boolean) {
  if (isEmpty(value)) return;
  if (typeof value === 'string') {
    emitString(key, value, indent, lines, opts.full ? Infinity : codeKey ? 3000 : 400);
    return;
  }
  if (typeof value !== 'object') {
    lines.push(`${indent}${key}: ${String(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.every(v => typeof v !== 'object' || v === null)) {
      lines.push(`${indent}${key}: [${value.map(v => String(v)).join(', ')}]`);
      return;
    }
    lines.push(`${indent}${key}:`);
    for (const item of value) {
      const sub: string[] = [];
      emitObject(item as Record<string, unknown>, `${indent}    `, sub, opts);
      if (sub.length === 0) continue;
      sub[0] = `${indent}  - ${sub[0].trimStart()}`;
      lines.push(...sub);
    }
    return;
  }
  const record = value as Record<string, unknown>;
  if ('__rl' in record) {
    const label = record.cachedResultName ? ` (${record.cachedResultName})` : '';
    lines.push(`${indent}${key}: ${String(record.value ?? '')}${label}`);
    return;
  }
  lines.push(`${indent}${key}:`);
  emitObject(record, `${indent}  `, lines, opts);
}

function emitObject(record: Record<string, unknown>, indent: string, lines: string[], opts: EmitOptions) {
  if (!record || typeof record !== 'object') {
    if (!isEmpty(record)) lines.push(`${indent}${String(record)}`);
    return;
  }
  for (const [key, value] of Object.entries(record)) {
    if (SKIP_KEYS.has(key)) continue;
    // Per-entry UUIDs (assignment and condition ids) carry no meaning for reading; edits address entries by index.
    if (key === 'id' && typeof value === 'string' && UUID.test(value)) continue;
    emitValue(key, value, indent, lines, opts, key === 'jsCode' || key === 'pythonCode' || key === 'functionCode');
  }
}

function nodeSettings(node: WorkflowNode): string {
  const parts: string[] = [];
  if (node.disabled) parts.push('disabled');
  if (node.onError) parts.push(`onError=${node.onError}`);
  if (node.continueOnFail) parts.push('continueOnFail');
  if (node.retryOnFail) parts.push(`retry=${node.maxTries ?? 3}x${node.waitBetweenTries ? `/${node.waitBetweenTries}ms` : ''}`);
  if (node.alwaysOutputData) parts.push('alwaysOutputData');
  if (node.executeOnce) parts.push('executeOnce');
  if (node.credentials) parts.push(`credentials: ${Object.keys(node.credentials).join(', ')}`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------------------------
// Zoom

function outputNote(ctx: LensContext, name: string): string {
  const output = ctx.outputs.get(name);
  if (!output) return '';
  if (output.error) return ` [last run error: ${clip(output.error, 80)}]`;
  return ` [out ${output.items} items: ${formatFields(output.fields)}]`;
}

function readsLines(ctx: LensContext, name: string): string[] {
  const lines: string[] = [];
  for (const read of ctx.deps.reads(name)) {
    const known = ctx.graph.nodes.has(read.node);
    if (!known) {
      lines.push(`  ${read.via} <- ${read.node}: NOT FOUND in this workflow (fields ${read.fields.join(', ') || 'whole item'})`);
      continue;
    }
    const fieldNotes = read.fields.map(field => {
      if (read.via === 'name') {
        const fields = ctx.outputs.get(read.node)?.fields;
        const top = field.split('.')[0].replace(/\[\d+\]$/, '');
        if (fields && !fields.has(field) && !fields.has(top)) return `${field} (MISSING in last run output)`;
        return field;
      }
      const origin = ctx.deps.originOf(name, field);
      if (origin.missing) return `${field} (MISSING in last run input)`;
      if (origin.origin && origin.origin !== read.node) return `${field} (set by ${origin.origin}${regionTag(ctx, origin.origin)})`;
      return field;
    });
    const fields = fieldNotes.length ? `: ${fieldNotes.join(', ')}` : '';
    lines.push(`  ${read.via} <- ${read.node}${regionTag(ctx, read.node)}${fields}${outputNote(ctx, read.node)}`);
  }
  return lines;
}

export function renderZoom(ctx: LensContext, names: string[], opts: EmitOptions): string {
  const blocks: string[] = [];
  for (const name of names) {
    const node = ctx.graph.nodes.get(name);
    if (!node) continue;
    const lines: string[] = [];
    const region = ctx.regions.regionOf.get(name);
    lines.push(`## ${name} [${region?.id ?? '?'}] ${node.type} v${node.typeVersion ?? 1}`);
    const settings = nodeSettings(node);
    if (settings) lines.push(settings);
    const params: string[] = [];
    emitObject((node.parameters ?? {}) as Record<string, unknown>, '  ', params, opts);
    if (params.length) lines.push('params:', ...params);
    if (!isAiSubNode(ctx.graph, name)) {
      const reads = readsLines(ctx, name);
      if (reads.length) lines.push('reads:', ...reads);
      const readers = ctx.deps.readers(name).filter(r => r.via === 'name' || r.fields.length > 0);
      if (readers.length) {
        lines.push(`read by: ${readers.map(r => `${r.node}${regionTag(ctx, r.node)} (${r.via}${r.fields.length ? `: ${r.fields.join(', ')}` : ''})`).join('; ')}`);
      }
      const edges = edgesText(ctx, name).trim();
      if (edges) lines.push(edges);
      const ai = aiText(ctx, name);
      if (ai) lines.push(`ai: ${ai}`);
      const own = ctx.outputs.get(name);
      if (own) lines.push(`last run:${outputNote(ctx, name)}`);
    } else {
      const served = (ctx.graph.out.get(name) ?? []).filter(e => e.type !== 'main').map(e => `${e.to} (${AI_PORT_ALIASES[e.type] ?? e.type})`);
      if (served.length) lines.push(`serves: ${served.join(', ')}`);
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------------------------
// Find

export function renderFind(ctx: LensContext, query: string, limit = 40): string {
  const needle = query.toLowerCase();
  const hits: string[] = [];
  const add = (line: string) => {
    if (hits.length < limit) hits.push(line);
  };
  let total = 0;
  for (const name of ctx.graph.order) {
    const node = ctx.graph.nodes.get(name)!;
    const tag = regionTag(ctx, name);
    if (name.toLowerCase().includes(needle) || node.type.toLowerCase().includes(needle)) {
      total++;
      add(`- ${nodeHead(node)}${tag}: name/type match`);
    }
    const walk = (value: unknown, path: string) => {
      if (typeof value === 'string') {
        const index = value.toLowerCase().indexOf(needle);
        if (index >= 0) {
          total++;
          const start = Math.max(0, index - 50);
          const snippet = value.slice(start, index + needle.length + 50).replace(/\s+/g, ' ');
          add(`- ${name}${tag} ${path}: ${start > 0 ? '...' : ''}${snippet}${index + needle.length + 50 < value.length ? '...' : ''}`);
        }
      } else if (Array.isArray(value)) {
        value.forEach((item, i) => walk(item, `${path}[${i}]`));
      } else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key);
      }
    };
    walk(node.parameters ?? {}, '');
  }
  for (const sticky of ctx.graph.stickies) {
    const content = String((sticky.parameters as any)?.content ?? '');
    const index = content.toLowerCase().indexOf(needle);
    if (index >= 0) {
      total++;
      add(`- sticky note "${clip(content, 40)}": ...${clip(content.slice(Math.max(0, index - 40), index + needle.length + 40), 100)}...`);
    }
  }
  if (total === 0) return `no match for "${query}" in ${ctx.graph.nodes.size} nodes (names, types, parameters, sticky notes)`;
  const more = total > hits.length ? `\n... ${total - hits.length} more matches; refine the query` : '';
  return `${total} matches for "${query}":\n${hits.join('\n')}${more}`;
}
