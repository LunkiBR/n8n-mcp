/**
 * Compiles a compose spec (nodes keyed by name + flow lines) into either a complete n8n workflow
 * (create) or upstream diff operations (extend), so writes go through the same create path and
 * diff engine as every other tool.
 */

import { randomUUID } from 'crypto';
import { NodeRepository } from '../database/node-repository';
import { Workflow, WorkflowConnection, WorkflowNode } from '../types/n8n-api';
import { WorkflowDiffOperation } from '../types/workflow-diff';
import { isStickyNote } from '../utils/node-classification';
import { FlowEdge, NotationError, parseFlow } from './notation';
import { resolveNodeType } from './types';
import { layoutWorkflow, placeNewNodes, Position } from './layout';

export interface NodeSpec {
  type?: string;
  /** typeVersion; defaults to the latest version in the node database. */
  v?: number;
  params?: Record<string, unknown>;
  credentials?: Record<string, unknown>;
  position?: Position;
  disabled?: boolean;
  onError?: WorkflowNode['onError'];
  notes?: string;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
  alwaysOutputData?: boolean;
  executeOnce?: boolean;
}

export interface ComposeSpec {
  workflowId?: string;
  name?: string;
  nodes?: Record<string, NodeSpec>;
  flow?: string[];
  remove?: string[];
  unlink?: string[];
  settings?: Record<string, unknown>;
}

const PASS_THROUGH = ['credentials', 'disabled', 'onError', 'notes', 'retryOnFail', 'maxTries', 'waitBetweenTries', 'alwaysOutputData', 'executeOnce'] as const;

function buildNode(name: string, spec: NodeSpec, repository: NodeRepository, position: Position): WorkflowNode {
  if (!spec.type) throw new NotationError(`node "${name}" needs a type`);
  const resolved = resolveNodeType(repository, spec.type);
  const node: WorkflowNode = {
    id: randomUUID(),
    name,
    type: resolved.type,
    typeVersion: spec.v ?? resolved.typeVersion,
    position: spec.position ?? position,
    parameters: spec.params ?? {},
  };
  for (const key of PASS_THROUGH) {
    if (spec[key] !== undefined) (node as any)[key] = spec[key];
  }
  if (resolved.isWebhook) node.webhookId = randomUUID();
  return node;
}

function knownNodes(nodes: WorkflowNode[], specs: Record<string, NodeSpec>, repository: NodeRepository) {
  const known = new Map<string, Pick<WorkflowNode, 'type' | 'typeVersion' | 'parameters' | 'onError'>>();
  for (const node of nodes) if (!isStickyNote(node.type)) known.set(node.name, node);
  for (const [name, spec] of Object.entries(specs)) {
    const current = known.get(name);
    const type = spec.type ? resolveNodeType(repository, spec.type) : undefined;
    known.set(name, {
      type: type?.type ?? current?.type ?? '',
      typeVersion: spec.v ?? type?.typeVersion ?? current?.typeVersion ?? 1,
      parameters: { ...(current?.parameters ?? {}), ...(spec.params ?? {}) },
      onError: spec.onError ?? current?.onError,
    });
  }
  return known;
}

function dedupe(edges: FlowEdge[]): FlowEdge[] {
  const seen = new Set<string>();
  return edges.filter(e => {
    const key = `${e.from}|${e.type}|${e.output}|${e.to}|${e.input}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function toConnections(edges: FlowEdge[]): WorkflowConnection {
  const connections: WorkflowConnection = {};
  for (const edge of edges) {
    connections[edge.from] ??= {};
    const outputs = (connections[edge.from][edge.type] ??= []);
    while (outputs.length <= edge.output) outputs.push([]);
    (outputs[edge.output] ??= []).push({ node: edge.to, type: edge.type, index: edge.input });
  }
  return connections;
}

export interface CreatePlan {
  workflow: Pick<Workflow, 'name' | 'nodes' | 'connections' | 'settings'>;
  edges: FlowEdge[];
}

export function compileCreate(spec: ComposeSpec, repository: NodeRepository): CreatePlan {
  if (!spec.name) throw new NotationError('a new workflow needs a name');
  const specs = spec.nodes ?? {};
  const names = Object.keys(specs);
  if (names.length === 0) throw new NotationError('a new workflow needs at least one node in nodes');
  const edges = dedupe(parseFlow(spec.flow ?? [], knownNodes([], specs, repository)));
  const positions = layoutWorkflow({ names, edges });
  const nodes = names.map(name => buildNode(name, specs[name], repository, positions.get(name)!));
  return {
    workflow: { name: spec.name, nodes, connections: toConnections(edges), settings: { executionOrder: 'v1', ...(spec.settings ?? {}) } },
    edges,
  };
}

function hasEdge(workflow: Workflow, edge: FlowEdge): boolean {
  return (workflow.connections?.[edge.from]?.[edge.type]?.[edge.output] ?? []).some(t => t?.node === edge.to && (t.index ?? 0) === edge.input);
}

export interface ExtendPlan {
  operations: WorkflowDiffOperation[];
  added: string[];
  updated: string[];
  removed: string[];
  linked: number;
  unlinked: number;
}

export function compileExtend(spec: ComposeSpec, workflow: Workflow, repository: NodeRepository): ExtendPlan {
  const specs = spec.nodes ?? {};
  const existing = new Map(workflow.nodes.map(n => [n.name, n]));
  const removed = spec.remove ?? [];
  for (const name of removed) if (!existing.has(name)) throw new NotationError(`cannot remove "${name}": no such node`);

  const operations: WorkflowDiffOperation[] = [];

  // Unlinks resolve against the workflow as it is now; edges of removed nodes go with the node.
  let unlinked = 0;
  for (const edge of dedupe(parseFlow(spec.unlink ?? [], knownNodes(workflow.nodes, {}, repository)))) {
    if (!hasEdge(workflow, edge)) throw new NotationError(`cannot unlink "${edge.from} -> ${edge.to}": no such connection`);
    unlinked++;
    if (removed.includes(edge.from) || removed.includes(edge.to)) continue;
    operations.push({ type: 'removeConnection', source: edge.from, target: edge.to, sourceOutput: edge.type, targetInput: edge.type });
  }
  for (const name of removed) operations.push({ type: 'removeNode', nodeName: name });

  const remaining = workflow.nodes.filter(n => !removed.includes(n.name));
  const known = knownNodes(remaining, specs, repository);

  const edges = dedupe(parseFlow(spec.flow ?? [], known)).filter(e => !hasEdge(workflow, e));
  const added = Object.keys(specs).filter(name => !existing.has(name) || removed.includes(name));
  const updated = Object.keys(specs).filter(name => existing.has(name) && !removed.includes(name));

  const positions = new Map<string, Position>(remaining.map(n => [n.name, n.position]));
  const placed = placeNewNodes(added, edges, positions);
  for (const name of added) {
    operations.push({ type: 'addNode', node: buildNode(name, specs[name], repository, placed.get(name)!) });
  }

  for (const name of updated) {
    const node = existing.get(name)!;
    const nodeSpec = specs[name];
    if (nodeSpec.type) {
      const wanted = resolveNodeType(repository, nodeSpec.type).type;
      if (wanted !== node.type) throw new NotationError(`node "${name}" is ${node.type}; to change its type, remove it and add a new node`);
    }
    const updates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(nodeSpec.params ?? {})) updates[`parameters.${key}`] = value;
    for (const key of PASS_THROUGH) if (nodeSpec[key] !== undefined) updates[key] = nodeSpec[key];
    if (nodeSpec.v !== undefined) updates.typeVersion = nodeSpec.v;
    if (nodeSpec.position) operations.push({ type: 'moveNode', nodeName: name, position: nodeSpec.position });
    if (Object.keys(updates).length > 0) operations.push({ type: 'updateNode', nodeName: name, updates });
  }

  for (const edge of edges) {
    operations.push({
      type: 'addConnection',
      source: edge.from,
      target: edge.to,
      sourceOutput: edge.type,
      targetInput: edge.type,
      sourceIndex: edge.output,
      targetIndex: edge.input,
    });
  }
  if (spec.name && spec.name !== workflow.name) operations.push({ type: 'updateName', name: spec.name });
  if (spec.settings) operations.push({ type: 'updateSettings', settings: spec.settings });

  return { operations, added, updated, removed, linked: edges.length, unlinked };
}
