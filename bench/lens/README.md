# Workflow lens benchmark

Measures whether `n8n_inspect_workflow` and `n8n_compose_workflow` let an agent analyze large workflows and author complex ones with fewer tokens, without losing correctness.

## Conditions

- **upstream**: an unmodified checkout of czlonkowski/n8n-mcp at the commit this branch is based on (v2.94.0), built and run as-is.
- **fork**: this branch.
- **fork-nolens** (optional): this branch with the two new tools disabled, to separate their effect from the other changes on the branch.

Both conditions talk to the same local n8n (2.43.x), with the same fixtures, prompts, agent model and grader.

## Agent

Each run is one fresh agent (Claude Sonnet) that receives the task prompt in `D:/n8nmcp/bench-runs/<run>/prompt.txt`.
The prompt is identical across conditions except for the tool list file and the condition name in the tool command.
The agent calls MCP tools through `agent-tool.mjs`, a stdio MCP client, from its shell; it is told not to read any other file.

Results longer than 25,000 characters are written to a file and the agent is told where, because the shell truncates long output.
A native MCP client would have placed those results in the agent's context, so this can only lower a condition's measured token count.
For that reason the report shows two measures:

- **MCP result chars**: the total size of everything the server returned, which is what a native MCP client puts in context.
- **agent tokens**: the token count the agent harness reports for the run, including its fixed overhead (system prompt, tool list); a calibration run per condition measures that overhead.

## Tasks

| task | kind | fixture | what is checked |
|---|---|---|---|
| dm-credentials | read, cross-region dependency | template 7311 (154 nodes) | the DM sender, the node supplying its credentials (read by name from another region), the node supplying the text, the endpoint |
| drive-folders | read, search | template 13245 (195 nodes) | the login nodes and their path, the set of nodes creating Drive folders |
| agent-wiring | read, AI sub-nodes | template 9100 (156 nodes) | models, tool node and the workflow it calls, output parser keys of one agent |
| edit-content-engine | edit | template 9100 (156 nodes, has an orphan node) | new node added and wired after a given node, one option changed, nothing else changed |
| fix-discount | debug with run data | 28-node order pipeline with a planted field-name bug, executed once | root cause named, and a copy of the fixed workflow, executed, produces the expected totals |
| create-support-triage | create | none | 11 structural checks (triggers, AI agent with model and parser, switch routes, error output, loop wiring) and validation without errors |

Template fixtures are public workflows from n8n.io (`fixtures/template-<id>.json`, source URL inside).
Ground truth comes from the raw JSON, not from the lens code under test.

## Reproduce

```bash
# local n8n
D:/n8nmcp/testbed/start-n8n.sh
# one run
node bench/lens/prompt.mjs <task> <condition> <runId>      # prepares the run and prints the prompt
# ... run an agent on the prompt ...
node bench/lens/record.mjs <runId> <agentTokens> <toolUses> <durationMs>
node bench/lens/report.mjs
```

`harness.mjs` holds fixtures setup and graders; `reference/` holds a reference solution used to validate the create grader.
