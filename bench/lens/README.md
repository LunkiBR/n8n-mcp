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

## Results (2026-10-18)

72 valid runs: Claude Sonnet on upstream (19) and on three successive fork builds (37), Claude Haiku on upstream (8) and the fork (8), plus one calibration run per condition.
Raw rows: `results/2026-10-18.jsonl`; excluded runs and why: `results/2026-10-18-excluded.txt`.
Fork builds: `fork` (first build), `fork-r2` (after one round of changes driven by agent traces: edit-ready zoom, resource-mapper schema summaries, compact JSON, placed nodes), `fork-r3` (compose reports the verified change after an edit).

| | upstream, Sonnet | fork, Sonnet | upstream, Haiku | fork, Haiku |
|---|---|---|---|---|
| tasks solved | 15/19 | 37/37 | 7/8 | 8/8 |
| median MCP result chars per run | 104,133 | 13,685 | 225,129 | 34,157 |
| total MCP result chars | 3.24M | 0.65M (37 runs) | 2.33M | 0.29M |
| median calls per run | 6 | 5 | 5.5 | 7.5 |
| median agent tokens per run | 98.1k | 93.0k | 117.1k | 108.7k |

What the numbers say, and what they do not:

- **Every upstream failure is one deterministic cause**: editing a real template that already contains a disconnected node. Upstream refuses every partial or full update of such a workflow, whatever the edit touches, so the agent cannot finish without changing an unrelated node. The fork fixes this in the diff handler (only structure errors an edit introduces block it). On the other tasks both conditions solved everything; this benchmark does not show the lens raising success rates for strong models on read tasks.
- **Context load is where the lens matters**: the server returned 6.6x to 7.6x less text per run (median), and up to 50x less on edits after `fork-r3` (upstream 148k to 330k chars, fork-r3 2.6k to 7.3k chars).
- **Agent tokens moved less** (5% to 7% median), because about 83k of every run is fixed overhead (calibration) and because results over 25k chars were spilled to a file the agent could search, which an MCP client would instead put in context. Three upstream runs pulled 600k to 740k chars and relied on that spill; in a native client, results that size (roughly 170k to 210k tokens) would not fit alongside the rest of a 200k-token context. That case was not run here.
- **Authoring**: creating a 17-node workflow took upstream agents 15 to 31 calls (mostly `get_node`) and 11k to 19k chars of arguments; fork agents used 3 to 6 calls and 5k to 7k chars. Every created workflow in both conditions passed all 11 structural checks and validation.
- Sample sizes are small (2 runs per task and condition for most tasks); treat per-task medians as indicative.
