/**
 * Workflow lens: token-bounded views of an n8n workflow for agents.
 * Pure functions over a workflow object; fetching from n8n happens in the MCP handler.
 */

import { Workflow } from '../types/n8n-api';
import { buildGraph } from './graph';
import { detectRegions, Region } from './regions';
import { DependencyIndex } from './deps';
import { NodeOutput, outputsFromPinData } from './schema';
import { LensContext, renderFind, renderOutline, renderOverview, renderZoom } from './render';

export type LensView = 'overview' | 'outline' | 'zoom' | 'find';

export interface InspectOptions {
  view: LensView;
  /** Node names for `zoom`. */
  nodes?: string[];
  /** Region id (`R3`) or name for `outline` and `zoom`. */
  region?: string;
  /** Text for `find`. */
  query?: string;
  /** Disable truncation of long parameter values in `zoom`. */
  full?: boolean;
  /** Per-node outputs from the latest execution; falls back to the workflow's pinData. */
  outputs?: Map<string, NodeOutput>;
  outputsLabel?: string;
}

export function createLensContext(workflow: Workflow, outputs?: Map<string, NodeOutput>, outputsLabel?: string): LensContext {
  const graph = buildGraph(workflow);
  const regions = detectRegions(graph);
  const merged = new Map<string, NodeOutput>(outputsFromPinData((workflow as any).pinData));
  for (const [name, output] of outputs ?? []) merged.set(name, output);
  return { graph, regions, deps: new DependencyIndex(graph, merged), outputs: merged, outputsLabel };
}

export function findRegion(ctx: LensContext, ref: string): Region | undefined {
  const wanted = ref.trim().toLowerCase();
  return ctx.regions.regions.find(r => r.id.toLowerCase() === wanted)
    ?? ctx.regions.regions.find(r => r.name.toLowerCase() === wanted)
    ?? ctx.regions.regions.find(r => r.name.toLowerCase().includes(wanted));
}

export class LensInputError extends Error {}

export function inspect(workflow: Workflow, options: InspectOptions): string {
  const ctx = createLensContext(workflow, options.outputs, options.outputsLabel);
  const region = options.region ? findRegion(ctx, options.region) : undefined;
  if (options.region && !region) {
    throw new LensInputError(`region "${options.region}" not found; regions: ${ctx.regions.regions.map(r => `${r.id} ${r.name}`).join('; ')}`);
  }

  switch (options.view) {
    case 'overview':
      return renderOverview(ctx);
    case 'outline':
      return renderOutline(ctx, region);
    case 'zoom': {
      const requested = options.nodes ?? [];
      if (requested.length === 0 && !region) throw new LensInputError('zoom needs nodes=[...] or region=<id>');
      const missing = requested.filter(n => !ctx.graph.nodes.has(n));
      const names = [...(region?.nodes ?? []), ...requested.filter(n => ctx.graph.nodes.has(n))];
      const unique = [...new Set(names)];
      const header = ctx.outputsLabel ? `run data: ${ctx.outputsLabel}` : ctx.outputs.size ? 'run data: pinData' : 'run data: none (field lists come from parameters only)';
      const notFound = missing.length ? `\nnot found: ${missing.join(', ')}` : '';
      return `${header}${notFound}\n\n${renderZoom(ctx, unique, { full: options.full === true })}`;
    }
    case 'find':
      if (!options.query) throw new LensInputError('find needs query=<text>');
      return renderFind(ctx, options.query);
  }
}

export { NodeOutput, outputsFromExecution } from './schema';
export { estimateTokens } from './render';
