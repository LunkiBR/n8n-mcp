# Workflow lens and compose

This branch adds two tools to n8n-mcp for working with large workflows at a fraction of the usual context cost, and fixes partial updates on workflows that already contain an orphan node.
Benchmark method and results: [bench/lens/README.md](../bench/lens/README.md).

## Run it from a checkout

```bash
git clone -b feat/workflow-lens https://github.com/LunkiBR/n8n-mcp.git
cd n8n-mcp
npm ci --legacy-peer-deps
npm run build
```

On Windows with Node 24, `better-sqlite3@11` has no prebuilt binary; install `better-sqlite3@12` locally with `npm install --no-save better-sqlite3@12` (allow its install script), or the server falls back to sql.js without full-text search.

Claude Code (`.mcp.json` in your project, or `claude mcp add`):

```json
{
  "mcpServers": {
    "n8n-lens": {
      "command": "node",
      "args": ["/path/to/n8n-mcp/dist/mcp/index.js"],
      "env": {
        "MCP_MODE": "stdio",
        "LOG_LEVEL": "error",
        "DISABLE_CONSOLE_OUTPUT": "true",
        "N8N_API_URL": "https://your-n8n.example.com",
        "N8N_API_KEY": "<your n8n API key>"
      }
    }
  }
}
```

All upstream tools keep working as before.
Tool results are sent as compact JSON; set `N8N_MCP_COMPACT_JSON=false` for indented output.
For an n8n on localhost, upstream's SSRF protection needs `WEBHOOK_SECURITY_MODE=moderate`.

## `n8n_inspect_workflow`

Read a workflow at the level of detail the task needs, as plain text.

| view | returns | typical size on a 150-node workflow |
|---|---|---|
| `overview` | regions (from canvas groups, sticky notes, or automatic segmentation), triggers, cross-region links, structural issues, the cost of zooming each region | 0.7k to 1.1k tokens |
| `outline` | one line per node with its type, a one-line summary of its configuration and its outgoing edges; whole workflow or `region` | 2k to 7k tokens for the whole workflow |
| `zoom` | for named `nodes` or a `region`: stored parameters, everything each node reads (nodes referenced by name, input fields with their types from the latest execution, fields missing from the last run), who reads its output, and every connection in and out | 0.2k to 2k tokens per node |
| `find` | where a text occurs in names, parameters, expressions and sticky notes | small |

A zoom never hides a node the zoomed nodes depend on: references like `$('Set Config').item.json.api_base` are listed with the referenced node's region and output fields even when it is far away in the graph.
Long values are truncated with their size; `full: true` shows everything.

## `n8n_compose_workflow`

Create a workflow, or extend and edit one, from compact notation instead of full n8n JSON.

```json
{
  "name": "Lead router",
  "nodes": {
    "Webhook": { "type": "webhook", "params": { "path": "lead", "httpMethod": "POST" } },
    "Is Hot":  { "type": "if", "params": { "conditions": { "...": "..." } } },
    "Enrich":  { "type": "httpRequest", "params": { "url": "https://api.example.com" }, "onError": "continueErrorOutput" },
    "Alert":   { "type": "set", "params": { "assignments": { "assignments": [{ "name": "error", "value": "={{ $json.error.message }}", "type": "string" }] } } },
    "Agent":   { "type": "agent", "params": { "text": "={{ $json.summary }}" } },
    "GPT":     { "type": "lmChatOpenAi", "params": { "model": { "__rl": true, "mode": "list", "value": "gpt-4o-mini" } } }
  },
  "flow": [
    "Webhook -> Is Hot",
    "Is Hot.true -> Enrich -> Agent",
    "Enrich.error -> Alert",
    "GPT =model=> Agent"
  ]
}
```

- Types are short names resolved against the bundled node database; typeVersion defaults to the latest.
- Flow lines: `A -> B -> C`; output by label (`If.true`, `Loop.loop`, `Loop.done`, `Http.error`, a Switch output key) or index (`Switch.2`); target input `Merge[1]`; AI ports `=model=>`, `=tool=>`, `=memory=>`, `=parser=>`, `=embedding=>`, `=retriever=>`, `=vectorStore=>`, `=document=>`, `=textSplitter=>`.
- With `workflowId`: listed new nodes are added next to their neighbors, listed existing nodes get the given parameter keys replaced (`"options.timeout": 5000` sets a nested value), `remove` deletes nodes, `unlink` removes connections. To insert X between A and B: `unlink: ["A -> B"]`, `flow: ["A -> X -> B"]`.
- The reply is a few lines: ids, the change verified by reading the workflow back from n8n, validation issues the change introduced (issues the workflow already had are only counted), and the next step.
- New workflows get a layered left-to-right layout with each trigger's flow in its own band; nodes a person placed are never moved.
