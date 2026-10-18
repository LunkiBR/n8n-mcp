# czlonkowski/n8n-mcp: token efficiency and large workflows (state at v2.94.0)

Researched 2026-10-17 against `main` via `gh api` (read only, nothing cloned).
Repo: https://github.com/czlonkowski/n8n-mcp - MIT license, 23k stars, latest release v2.94.0 (2026-10-15), npm `n8n-mcp@2.94.0`.
"Source" below means `https://github.com/czlonkowski/n8n-mcp/blob/main/<path>`.

## 1. Tool list (28 tools)

Docs tools, always listed (`src/mcp/tools.ts`):

- `tools_documentation` - docs for the tools; `depth` essentials (default) or full.
- `search_nodes` - FTS search, max 20; opt-in `includeExamples`, `includeOperations` (~100-300 tokens/result), `source` filter.
- `get_node` - node info; `detail` minimal (~200 tok) / standard (~1-2K, default) / full (~3-8K); modes info, docs, search_properties, versions, compare, breaking, migrations.
- `validate_node` - `mode` minimal (required fields) or full with profile.
- `get_template` - `mode` nodes_only / structure / full.
- `search_templates` - searchMode keyword / by_nodes / by_task / by_metadata / patterns.
- `validate_workflow` - validates a workflow JSON passed inline.

Management tools, listed only when `N8N_API_URL`/key is set (`src/mcp/tools-n8n-manager.ts`):

- `n8n_create_workflow` - create (inactive).
- `n8n_get_workflow` - read; 6 modes (section 2).
- `n8n_update_full_workflow` - replace nodes/connections.
- `n8n_update_partial_workflow` - diff operations (section 2).
- `n8n_delete_workflow` - delete.
- `n8n_list_workflows` - metadata only, cursor pagination, `excludePinnedData` default true.
- `n8n_validate_workflow` - validate by ID.
- `n8n_autofix_workflow` - preview/apply 13 fix types.
- `n8n_test_workflow` - run: auto/trigger over HTTP, prepare/pinned/direct via n8n's own MCP server.
- `n8n_executions` - get/list/delete; 5 get modes.
- `n8n_evaluations` - evaluation test runs (list_runs, get_run, list_cases, run, cancel).
- `n8n_health_check` - status / diagnostic.
- `n8n_workflow_versions` - list/get/rollback/diff/delete/prune, local or native history.
- `n8n_deploy_template` - deploy n8n.io template plus autofix.
- `n8n_manage_datatable` - data tables, rows, columns.
- `n8n_manage_folders` - folders (n8n 2.19+).
- `n8n_manage_credentials` - list/get/create/update/delete/getSchema.
- `n8n_audit_instance` - security audit plus workflow scan, markdown report.
- `n8n_manage_agents` - n8n Agents via instance MCP (n8n 2.34+).
- `n8n_explore_node_resources` - resolve loadOptions/listSearch values with a real credential.
- `n8n_list_catalog` - projects or tags.

Tool gating: `DISABLED_TOOLS` and `DISABLED_TOOL_OPERATIONS` env vars (`src/mcp/tool-policy.ts`, README).
`N8N_MCP_DISABLE_UI_APPS=true` drops MCP Apps `_meta.ui` from tool definitions and results (CHANGELOG 2.92.0).
There is no "lite" profile or slim-schema mode; issue/PR search for "lite" returns nothing.

## 2. Workflow read / edit / execution modes

`n8n_get_workflow` (`src/mcp/handlers-n8n-manager.ts` lines ~737-1094, dispatch `src/mcp/server.ts` ~1837):

| mode | returns |
|---|---|
| `full` (default) | Raw n8n GET body (nodes with all parameters, connections, settings, pinData, staticData, etc.) with only `activeVersion` removed. |
| `details` | `full` + stats from last 10 executions + webhook info. |
| `active` | Published graph (`activeVersion.nodes/connections`) + metadata; error `NO_ACTIVE_VERSION` if never published. |
| `structure` | Per node only `id, name, type, position, disabled`; full `connections`; nodeGroups; counts. No parameters, no typeVersion. |
| `filtered` | Full config of only the nodes in `nodeNames` (name or ID), plus `nodeCount`, `returnedCount`, `notFound`. Added 2.59.0 for #101. |
| `minimal` | id, name, active, isArchived, tags, createdAt, updatedAt. |

README line ~388 still lists only full/details/structure/minimal, so the README is out of date against the code.
The tool also sets `_meta["anthropic/maxResultSizeChars"]: 450000` so Claude Code accepts up to ~450K chars inline instead of the 25K-token default (CHANGELOG 2.53.0, #777).

`n8n_update_partial_workflow` (`src/types/workflow-diff.ts`, 21 op types): addNode, removeNode, updateNode (dot-path `updates`, bracket indices), moveNode, enableNode, disableNode, patchNodeField (find/replace or regex inside one field such as `parameters.jsCode`, JS syntax-checked since 2.72.0), addConnection, removeConnection, rewireConnection, cleanStaleConnections, replaceConnections, updateSettings, updateName, setNodeGroups, addTag, removeTag, activateWorkflow, deactivateWorkflow, transferWorkflow, moveToFolder.
Flags: `validateOnly`, `continueOnError`.
Success response is small: `{id, name, active, nodeCount, operationsApplied}` + applied/failed/errors/warnings (`src/mcp/handlers-workflow-diff.ts` ~866).
Create and full update also return only `{id, name, active, nodeCount}`.

`n8n_executions` action=get (`src/services/execution-processor.ts`, handler ~2131):

- no mode: execution metadata without run data (fetched with `includeData=false`).
- `preview`: per-node structure, item counts, estimated KB, plus a recommendation of which mode to use next.
- `summary`: 2 items per node (also what legacy `includeData:true` maps to).
- `filtered`: `nodeNames` + `itemsLimit` (0 = structure, -1 = unlimited, capped at 1000), `includeInputData`.
- `full`: everything.
- `error`: failing node, error, upstream sample (`errorItemsLimit`), optional stack trace and execution path.

Since 2.80.1, AI sub-node (`ai_*`) data and all runs of a node are merged in; summary/filtered merge only up to the limit.
action=list: up to 100 per page, `includeData` default false.
The tool description says "summary=2 items (default)", but the code returns raw metadata when no mode is given; doc/code mismatch.

## 3. Already token-efficient vs still heavy

Efficient:

- `get_node` detail levels, `search_nodes` opt-ins, `get_template` modes, patterns response trimmed ~64% (2.42.3, #683).
- `structure`, `filtered`, `minimal` workflow modes; `activeVersion` stripping roughly halved `full` on active workflows (2.53.0).
- Diff edits with tiny responses; `patchNodeField` for one-line Code-node edits.
- Execution preview/summary/filtered/error modes.
- Third-party measurement: 7 docs tools' schemas = 2,636 tokens (open PR #1072, by the measurement tool's author, not verified here).

Heavy:

- Every result is serialized with `JSON.stringify(result, null, 2)` (`src/mcp/server.ts` ~1062-1064): 2-space pretty-print on all payloads, including full workflows.
- `validate_*` results are sent twice, as text and as `structuredContent` (~1062, ~1090).
- `full`/`details`/`active` return the whole raw workflow, including pinData and staticData; the project's answer to big workflows is raising the size cap (450K chars), not shrinking output.
- `structure` still emits full `connections` and positions, and no typeVersion or parameter summary, so there is no "compact outline" in between structure and filtered.
- `validate_workflow` needs the whole workflow as input; `n8n_update_full_workflow` needs the full nodes array.
- 21 management tool schemas (49 KB of source in `tools-n8n-manager.ts`) are not covered by the 2,636-token figure; actual cost not measured here.
- Server-side truncation only at 1,000,000 chars (`server.ts` ~1072).

## 4. Node DB update mechanism and distribution

- Maintainer runs it locally, per `MEMORY_N8N_UPDATE.md`: `npm run update:n8n` (`scripts/update-n8n-deps.js` bumps n8n-nodes-base, n8n-core, n8n-workflow, @n8n/n8n-nodes-langchain), which rebuilds via `dist/scripts/rebuild.js`; then `fetch:community`, `generate:docs:*` (community summaries with a local LLM), VACUUM, bump version, CHANGELOG, PR.
- `data/nodes.db` is committed to git (70.8 MiB at 2.93.0; bulk columns gzip+base64 since 2.83.0 to stay under GitHub's 100 MiB limit, #1067).
- CI does not rebuild the DB. `.github/workflows/release.yml` runs on pushes to main that change `package.json`/`package.runtime.json`; it checks `data/nodes.db` exists, builds, and publishes to npm (trusted publisher), Docker (ghcr), MCPB bundle and GitHub release.
- npm package ships `dist`, `data/nodes.db`, skills, UI apps, with `package.runtime.json` as its manifest (no n8n packages at runtime; sql.js, optional better-sqlite3). Unpacked size 82 MB.
- Cadence: an n8n bump roughly every 1-2 weeks (2.84.0 2.38.x, 2.86.0 2.39.x, 2.88.0 2.40.x, 2.91.0 2.41.x, 2.93.0 2.43.x).

## 5. Contribution friendliness

- `CONTRIBUTING.md`: "Contributions are welcome", fork, enable "Allow edits by maintainers", run `npm test`. `AGENTS.md`: Conventional Commits, typecheck, coverage 75/70, and a required attribution line in commits and PR bodies.
- Last 200 merged PRs: 174 by czlonkowski, 13 dependabot, 3 Copilot, 10 external (for example #719 `DISABLED_TOOL_OPERATIONS`, #919 Cloudflare Access, #1073 latest on 2026-09-11).
- Of the 41 most recent closed external PRs, 10 were merged. The maintainer often reimplements them in his own PR with credit (#1040 into #1056; #965 shipped in 2.80.1).
- Solo maintainer (discussion #900). Since July 2026 the project has been repositioned toward the "production operations" side (validation, testing, versions, diagnosis), because n8n's official MCP now does diff-based authoring. Edit-cost parity is claimed in #900, except surgical edits, which are ~5x cheaper here.

## 6. Relevant issues, PRs, discussions

- PR #977 (open since 2026-08-04, no maintainer review, +4.5K lines): bound tool responses, store oversized JSON as queryable artifacts. https://github.com/czlonkowski/n8n-mcp/pull/977
- PR #1072 (open): context-cost badge, 2,636 tokens. https://github.com/czlonkowski/n8n-mcp/pull/1072
- PR #1089 (open): fall back to summary for successful error-mode requests. https://github.com/czlonkowski/n8n-mcp/pull/1089
- Issue #834 (open): `n8n_get_execution` hangs on big data. https://github.com/czlonkowski/n8n-mcp/issues/834
- Issue #716 (closed NOT_PLANNED): code-execution-with-MCP spike for token efficiency. https://github.com/czlonkowski/n8n-mcp/issues/716
- Issue #777 (closed): get_workflow exceeded the 25K-token cap; fixed by stripping activeVersion plus maxResultSizeChars. https://github.com/czlonkowski/n8n-mcp/issues/777
- Issue #101 (closed): long Code nodes truncated; led to `mode=filtered`. https://github.com/czlonkowski/n8n-mcp/issues/101
- Issue #576 (closed): Claude compaction on large workflows; maintainer advice was to use structure mode. https://github.com/czlonkowski/n8n-mcp/issues/576
- Discussions #473 and #482 (token usage), with maintainer answers pointing to #716. https://github.com/czlonkowski/n8n-mcp/discussions/473 , https://github.com/czlonkowski/n8n-mcp/discussions/482
- Discussion #900 (direction). https://github.com/czlonkowski/n8n-mcp/discussions/900

## Not checked

- Actual `tools/list` token size with management tools enabled (I did not run the server).
- Byte sizes of real `structure` vs `full` responses on a large workflow.
- `docs/workflow-diff-examples.md` and the `tools_documentation` full text.
