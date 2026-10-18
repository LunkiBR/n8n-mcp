/**
 * Graph model of an n8n workflow for the lens views.
 *
 * n8n stores connections keyed by source node name. This module indexes them in both
 * directions, separates `main` data edges from AI sub-node edges (`ai_*`), and resolves
 * each AI sub-node to the root node it serves (an agent, chain or vector store).
 */

import { Workflow, WorkflowNode } from '../types/n8n-api';
import { isStickyNote, isTriggerNode } from '../utils/node-classification';

export interface LensEdge {
  from: string;
  to: string;
  /** Connection type: `main` or an AI port such as `ai_languageModel`. */
  type: string;
  /** Output index on the source node. */
  output: number;
  /** Input index on the target node. */
  input: number;
}

export interface LensGraph {
  workflow: Workflow;
  /** Executable nodes by name, in workflow order. Sticky notes are excluded. */
  nodes: Map<string, WorkflowNode>;
  stickies: WorkflowNode[];
  out: Map<string, LensEdge[]>;
  in: Map<string, LensEdge[]>;
  triggers: string[];
  /** Node names in a stable topological order over `main` edges (cycles broken by workflow order). */
  order: string[];
}

export function buildGraph(workflow: Workflow): LensGraph {
  const nodes = new Map<string, WorkflowNode>();
  const stickies: WorkflowNode[] = [];
  for (const node of workflow.nodes ?? []) {
    if (isStickyNote(node.type)) stickies.push(node);
    else nodes.set(node.name, node);
  }

  const out = new Map<string, LensEdge[]>();
  const inn = new Map<string, LensEdge[]>();
  for (const name of nodes.keys()) {
    out.set(name, []);
    inn.set(name, []);
  }

  for (const [from, byType] of Object.entries(workflow.connections ?? {})) {
    if (!nodes.has(from) || !byType) continue;
    for (const [type, outputs] of Object.entries(byType)) {
      (outputs ?? []).forEach((targets, output) => {
        for (const target of targets ?? []) {
          if (!target || !nodes.has(target.node)) continue;
          const edge: LensEdge = { from, to: target.node, type, output, input: target.index ?? 0 };
          out.get(from)!.push(edge);
          inn.get(target.node)!.push(edge);
        }
      });
    }
  }

  const triggers = [...nodes.values()].filter(n => isTriggerNode(n.type)).map(n => n.name);

  const graph: LensGraph = { workflow, nodes, stickies, out, in: inn, triggers, order: [] };
  graph.order = topologicalOrder(graph);
  return graph;
}

function mainIn(inn: Map<string, LensEdge[]>, name: string): LensEdge[] {
  return (inn.get(name) ?? []).filter(e => e.type === 'main');
}

function mainOut(out: Map<string, LensEdge[]>, name: string): LensEdge[] {
  return (out.get(name) ?? []).filter(e => e.type === 'main');
}

function isAiSubNodeIn(out: Map<string, LensEdge[]>, name: string): boolean {
  return (out.get(name) ?? []).some(e => e.type !== 'main');
}

export function mainParents(graph: LensGraph, name: string): LensEdge[] {
  return mainIn(graph.in, name);
}

export function mainChildren(graph: LensGraph, name: string): LensEdge[] {
  return mainOut(graph.out, name);
}

/** AI edges feeding into a root node (its model, tools, memory, ...). */
export function aiInputs(graph: LensGraph, name: string): LensEdge[] {
  return (graph.in.get(name) ?? []).filter(e => e.type !== 'main');
}

/** True when the node only serves another node through an AI port. */
export function isAiSubNode(graph: LensGraph, name: string): boolean {
  return isAiSubNodeIn(graph.out, name) && mainOut(graph.out, name).length === 0 && mainIn(graph.in, name).length === 0;
}

/**
 * The node an AI sub-node ultimately serves. Sub-nodes can be nested (embeddings feeding a
 * vector store tool feeding an agent), so this follows AI edges until a node with none.
 */
export function aiRoot(graph: LensGraph, name: string): string {
  let current = name;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    if (!isAiSubNode(graph, current)) return current;
    const next = (graph.out.get(current) ?? []).find(e => e.type !== 'main');
    if (!next) return current;
    current = next.to;
  }
  return current;
}

function topologicalOrder(graph: LensGraph): string[] {
  const names = [...graph.nodes.keys()];
  const indegree = new Map<string, number>();
  for (const name of names) indegree.set(name, 0);
  for (const name of names) {
    for (const edge of mainChildren(graph, name)) indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const result: string[] = [];
  const placed = new Set<string>();
  const queue = names.filter(n => indegree.get(n) === 0 && !isAiSubNode(graph, n));
  // Triggers first so regions are numbered from where data enters.
  queue.sort((a, b) => Number(graph.triggers.includes(b)) - Number(graph.triggers.includes(a)));

  const visit = (name: string) => {
    if (placed.has(name)) return;
    placed.add(name);
    result.push(name);
    // AI sub-nodes are listed right after the root they serve.
    for (const edge of aiInputs(graph, name)) visit(edge.from);
  };

  while (result.length < names.length) {
    while (queue.length > 0) {
      const name = queue.shift()!;
      if (placed.has(name)) continue;
      visit(name);
      for (const edge of mainChildren(graph, name)) {
        const remaining = (indegree.get(edge.to) ?? 0) - 1;
        indegree.set(edge.to, remaining);
        if (remaining <= 0 && !placed.has(edge.to)) queue.push(edge.to);
      }
    }
    // A cycle (loops through SplitInBatches) or orphaned sub-nodes remain: take the next in workflow order.
    const next = names.find(n => !placed.has(n));
    if (next === undefined) break;
    queue.push(next);
  }
  return result;
}
