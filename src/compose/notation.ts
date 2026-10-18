/**
 * Flow notation for wiring nodes, shared by n8n_compose_workflow and the lens views.
 *
 *   "Webhook -> Score -> Hot?"          main chain, output 0 to input 0
 *   "Hot?.true -> Agent"                output chosen by label (true/false, done/loop, kept/discarded,
 *                                       error, a Switch outputKey) or by index ("Switch.2")
 *   "A -> Merge[1]"                     input index on the target
 *   "GPT =model=> Agent"                AI port; aliases model, tool, memory, parser, embedding,
 *                                       retriever, vectorStore, document, textSplitter, reranker,
 *                                       or the full type (=ai_languageModel=>)
 *
 * Node names are matched exactly first, so names containing dots or brackets still work.
 */

import { WorkflowNode } from '../types/n8n-api';
import { AI_PORT_ALIASES, outputLabel } from '../lens/render';

export interface FlowEdge {
  from: string;
  to: string;
  type: string;
  output: number;
  input: number;
}

export class NotationError extends Error {}

const ARROW = /\s*(->|=[A-Za-z_]+=>)\s*/;
const PORT_BY_ALIAS: Record<string, string> = Object.fromEntries(
  Object.entries(AI_PORT_ALIASES).map(([type, alias]) => [alias.toLowerCase(), type])
);

interface Ref {
  name: string;
  selector?: string;
  input?: number;
}

function closest(token: string, names: Iterable<string>): string[] {
  const lower = token.toLowerCase();
  return [...names].filter(n => n.toLowerCase() === lower || n.toLowerCase().includes(lower) || lower.includes(n.toLowerCase())).slice(0, 3);
}

function resolveRef(token: string, names: Set<string>, line: string): Ref {
  if (names.has(token)) return { name: token };
  let base = token;
  let input: number | undefined;
  const bracket = /^(.*)\[(\d+)\]$/.exec(token);
  if (bracket) {
    base = bracket[1];
    input = Number(bracket[2]);
    if (names.has(base)) return { name: base, input };
  }
  const dot = base.lastIndexOf('.');
  if (dot > 0) {
    const name = base.slice(0, dot);
    if (names.has(name)) return { name, selector: base.slice(dot + 1), input };
  }
  const suggestions = closest(base.replace(/\.[^.]*$/, ''), names);
  throw new NotationError(`unknown node "${token}" in flow "${line}"${suggestions.length ? `; did you mean ${suggestions.map(s => `"${s}"`).join(', ')}?` : ''}`);
}

function portType(arrow: string, line: string): string {
  if (arrow === '->') return 'main';
  const port = arrow.slice(1, -2);
  if (port.startsWith('ai_')) return port;
  const type = PORT_BY_ALIAS[port.toLowerCase()];
  if (!type) throw new NotationError(`unknown AI port "${port}" in flow "${line}"; use one of ${Object.values(AI_PORT_ALIASES).join(', ')}`);
  return type;
}

/** Output index for a selector on a node: a number, or a label as the lens prints it. */
export function resolveOutput(node: Pick<WorkflowNode, 'type' | 'typeVersion' | 'parameters' | 'onError'> | undefined, selector: string | undefined, line: string): number {
  if (selector === undefined) return 0;
  if (/^\d+$/.test(selector)) return Number(selector);
  if (node) {
    const full = { id: '', name: '', position: [0, 0] as [number, number], ...node } as WorkflowNode;
    for (let i = 0; i < 64; i++) {
      if (outputLabel(full, i).toLowerCase() === selector.toLowerCase()) return i;
    }
  }
  throw new NotationError(`unknown output "${selector}" in flow "${line}"; use an index (Node.1) or a label such as true/false, done/loop, error`);
}

/**
 * Parses flow lines into edges. `nodes` maps every node name that may appear (new and existing)
 * to what is known of it, so output labels can be resolved.
 */
export function parseFlow(lines: string[], nodes: Map<string, Pick<WorkflowNode, 'type' | 'typeVersion' | 'parameters' | 'onError'>>): FlowEdge[] {
  const names = new Set(nodes.keys());
  const edges: FlowEdge[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(ARROW);
    if (parts.length < 3 || parts.length % 2 === 0) {
      throw new NotationError(`flow "${line}" must look like "A -> B" or "Model =model=> Agent"`);
    }
    const refs: Ref[] = [];
    for (let i = 0; i < parts.length; i += 2) refs.push(resolveRef(parts[i].trim(), names, line));
    for (let i = 0; i + 1 < refs.length; i++) {
      const from = refs[i];
      const to = refs[i + 1];
      const type = portType(parts[2 * i + 1], line);
      edges.push({
        from: from.name,
        to: to.name,
        type,
        output: type === 'main' ? resolveOutput(nodes.get(from.name), from.selector, line) : 0,
        input: to.input ?? 0,
      });
    }
  }
  return edges;
}
