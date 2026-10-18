/**
 * Tool definitions for the workflow lens (read) and compose (write) tools.
 * Kept apart from tools-n8n-manager.ts so upstream changes to that file rebase cleanly.
 */

import { ToolDefinition } from '../types';

export const lensTools: ToolDefinition[] = [
  {
    name: 'n8n_inspect_workflow',
    description: `Read a workflow at the level of detail you need, as compact text. Start with view='overview' (regions, triggers, issues; small even for 200-node workflows), then 'outline' (one line per node with its edges, for one region or all), 'zoom' (full parameters of chosen nodes or a region, plus what each node reads: referenced nodes, input fields with their real types from the latest execution, and who reads its output), or 'find' (where a text occurs in names, parameters, expressions, sticky notes). A zoom never hides a node the zoomed nodes depend on, and it shows the exact stored parameter values plus every connection in and out ('in:', 'out:'), so you can plan an edit from it without n8n_get_workflow. Zoom named nodes rather than whole regions when you know which ones you need. Edges read 'A -> B', 'If true-> X; false-> Y', 'Loop done-> ...; loop-> ...'; AI sub-nodes are listed under their agent. Edit with n8n_compose_workflow (or n8n_update_partial_workflow).`,
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
  {
    name: 'n8n_compose_workflow',
    description: `Create a workflow, or extend/edit one (workflowId), from compact notation instead of full n8n JSON. nodes: object keyed by node name -> {type, params, credentials?, v?, onError?, disabled?}. type is a short name ('webhook', 'httpRequest', 'code', 'if', 'switch', 'set', 'splitInBatches', 'agent', 'lmChatOpenAi', 'toolCode') or a full type; typeVersion defaults to the latest; positions are laid out automatically. params are the node's parameters as n8n stores them (check get_node when unsure). flow: lines like "Webhook -> Score -> Is Hot", "Is Hot.true -> Notify", "Is Hot.false -> Log", "Loop.loop -> Step", "Switch.2 -> X", "A -> Merge[1]" (input 1), "HTTP.error -> Alert" (needs onError='continueErrorOutput'), "Model =model=> Agent", "Tool =tool=> Agent" (ports: model, tool, memory, parser, embedding, retriever, vectorStore, document, textSplitter). With workflowId: listed new nodes are added and placed next to their neighbors, listed existing nodes get the given params keys replaced (dot keys like 'options.timeout' set nested values), flow adds connections, remove deletes nodes, unlink removes connections (to insert X between A and B: unlink 'A -> B', flow 'A -> X -> B'). Returns ids, a validation summary by node, and the next step; no workflow echo. Build big workflows in several calls, one stage at a time.`,
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Existing workflow to extend or edit; omit to create a new one' },
        name: { type: 'string', description: 'Workflow name (required when creating)' },
        nodes: {
          type: 'object',
          description: 'Node name -> {type, params, credentials, v, onError, disabled, notes, retryOnFail, position}',
          additionalProperties: { type: 'object' },
        },
        flow: { type: 'array', items: { type: 'string' }, description: 'Connections in arrow notation' },
        remove: { type: 'array', items: { type: 'string' }, description: 'Node names to delete (with workflowId)' },
        unlink: { type: 'array', items: { type: 'string' }, description: 'Connections to remove, same arrow notation (with workflowId)' },
        settings: { type: 'object', description: 'Workflow settings to set, e.g. {"timezone": "UTC"}' },
      },
    },
    annotations: {
      title: 'Compose Workflow',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
];
