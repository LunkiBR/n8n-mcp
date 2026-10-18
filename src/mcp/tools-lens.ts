/**
 * Tool definitions for the workflow lens (read) and compose (write) tools.
 * Kept apart from tools-n8n-manager.ts so upstream changes to that file rebase cleanly.
 */

import { ToolDefinition } from '../types';

export const lensTools: ToolDefinition[] = [
  {
    name: 'n8n_inspect_workflow',
    description: `Read a workflow at the level of detail you need, as compact text. Start with view='overview' (regions, triggers, issues; small even for 200-node workflows), then 'outline' (one line per node with its edges, for one region or all), 'zoom' (full parameters of chosen nodes or a region, plus what each node reads: referenced nodes, input fields with their real types from the latest execution, and who reads its output), or 'find' (where a text occurs in names, parameters, expressions, sticky notes). A zoom never hides a node the zoomed nodes depend on. Edges read 'A -> B', 'If true-> X; false-> Y', 'Loop done-> ...; loop-> ...'; AI sub-nodes are listed under their agent. Use n8n_update_partial_workflow or n8n_compose_workflow to edit.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Workflow ID' },
        view: {
          type: 'string',
          enum: ['overview', 'outline', 'zoom', 'find'],
          default: 'overview',
          description: 'overview=regions map; outline=one line per node; zoom=parameters + data dependencies; find=text search',
        },
        region: { type: 'string', description: "Region id from the overview (e.g. 'R3') or its name; for outline and zoom" },
        nodes: { type: 'array', items: { type: 'string' }, description: 'Node names to zoom into' },
        query: { type: 'string', description: 'Text to search for (view=find), case-insensitive' },
        full: { type: 'boolean', description: 'zoom: do not truncate long parameter values (code, prompts)', default: false },
        executionId: { type: 'string', description: 'zoom: read field types from this execution instead of the latest one' },
        runData: { type: 'boolean', description: 'zoom: set false to skip loading run data', default: true },
      },
      required: ['id'],
    },
    annotations: {
      title: 'Inspect Workflow',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
];
