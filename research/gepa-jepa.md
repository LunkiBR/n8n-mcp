# GEPA vs JEPA for a token-efficient n8n MCP server

Question: "pense se os modelos JEV poderiam ajudar" - is "JEV" GEPA or JEPA, and could either help design an agent-ergonomic MCP server for n8n (compact graph overview, zoom, authoring DSL, tool descriptions)?
Date of research: 2026-10-17.
All claims below come from primary sources (arXiv, official repos, PyPI); third-party mirrors were seen in search but not relied on.

## Verdict

GEPA is directly applicable: it is a black-box optimizer for agent-facing text, and its official repo ships an MCP adapter whose purpose is optimizing MCP tool descriptions and system prompts.
JEPA is not applicable in practice: every JEPA variant is a self-supervised training objective that needs model weights and gradients, and none produces a text format an API model (Claude) can consume.

## 1. GEPA

### What it is

- Paper: "GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning", Agrawal et al., arXiv 2507.19457 (v1 Jul 2025, v2 Feb 2026, ICLR 2026 oral). https://arxiv.org/abs/2507.19457
- Claims: beats GRPO by 6% on average (up to 20%) with up to 35x fewer rollouts, and beats MIPROv2 by over 10%. (abstract)

### How it works (paper, Algorithms 1-2)

1. Keep a pool of candidates (each candidate = a dict of named text components).
2. Select a parent by per-instance Pareto selection: any candidate that is best on at least one validation instance stays on the frontier, sampled proportionally to how many instances it leads.
3. Pick one component (round-robin), run the candidate on a small minibatch, and collect scores plus traces plus textual feedback.
4. A reflection LM reads the current text, the traces and the feedback, and proposes a rewrite.
5. If the minibatch score improves, the child joins the pool and is scored on the Pareto set.
6. Optional "system-aware merge" combines the best components from different lineages.

The key input is the feedback function μ_f: it returns a score plus feedback text (compiler errors, failed rubric items, etc.), not just a scalar. https://arxiv.org/html/2507.19457v2

### Cost

Absolute budgets in the paper (Table 1, Qwen3 8B, full multi-module programs): HotpotQA 6,871, IFBench 3,593, HoVer 7,051, PUPA 2,426, AIME-2025 1,839, LiveBench-Math 1,839 rollouts, vs 24,000 for GRPO.
GEPA matched GRPO's best validation score after only 243 to 1,179 rollouts depending on task.
The repo's quickstart uses `max_metric_calls=150`. https://github.com/gepa-ai/gepa

### Package and API

- PyPI package `gepa`, latest 0.1.4 (2026-07-15). https://pypi.org/project/gepa/
- Minimal prompt optimization (README):

```python
result = gepa.optimize(seed_candidate={"system_prompt": "..."}, trainset=trainset, valset=valset,
                       task_lm="openai/gpt-4.1-mini", max_metric_calls=150, reflection_lm="openai/gpt-5")
```

- `optimize_anything` (source: `src/gepa/optimize_anything.py`), for any text artifact with a custom evaluator:

```python
from gepa.optimize_anything import optimize_anything, GEPAConfig, EngineConfig, ReflectionConfig
import gepa.optimize_anything as oa

def evaluate(candidate: dict[str, str], example) -> tuple[float, dict]:
    run = run_agent_on_task(candidate, example)   # your own rollout
    oa.log(f"validator errors: {run.errors}")     # "Actionable Side Information" fed to reflection
    return run.score, {"tokens": run.tokens, "tool_calls": run.tool_calls}

result = optimize_anything(
    seed_candidate={"tool_description_get_overview": "...", "dsl_reference": "..."},
    evaluator=evaluate, dataset=train, valset=val,
    objective="Agents complete n8n edit tasks correctly with the fewest tokens.",
    config=GEPAConfig(engine=EngineConfig(max_metric_calls=300),
                      reflection=ReflectionConfig(reflection_lm="anthropic/claude-...")),
)
```

- Evaluator contract (docstring): returns `(score, info)` where `info` is a free-form dict, or a bare float (info defaults to `{}`).
  Signature is `(candidate)` for single-task mode or `(candidate, example)` when a dataset is given.
  `seed_candidate` may be `str`, `dict[str, str]`, or `None` (seedless, bootstrapped from `objective`).
- Config (source: `src/gepa/gepa_launcher.py`): `EngineConfig.max_metric_calls` (a stopping condition is mandatory), `candidate_selection_strategy="pareto"`, `frontier_type="hybrid"`, `cache_evaluation=False`; `ReflectionConfig.reflection_lm` default `"openai/gpt-5.1"` (LiteLLM string or callable), `reflection_minibatch_size` defaults to 3 with a dataset; merge is off unless `GEPAConfig.merge` is set.
  The source notes this seed/evaluator path is legacy and recommends `gepa.optimize_anything.Task` for new code.

### Tool / MCP description optimization

- **MCP adapter exists**: `src/gepa/adapters/mcp_adapter/` (README calls it an early MVP). https://github.com/gepa-ai/gepa/tree/main/src/gepa/adapters/mcp_adapter
  - `MCPAdapter(tool_names, task_model, metric_fn, server_params=None, remote_url=None, remote_transport="sse", ..., base_system_prompt=..., enable_two_pass=True, failure_score=0.0)`.
  - Candidate keys: `tool_description`, `tool_description_<name>` (per tool), `system_prompt`.
  - Dataset items `MCPDataInst`: `user_query`, `tool_arguments`, `reference_answer`, `additional_context`.
  - `metric_fn(item, final_answer_str) -> float`.
  - Transports: stdio, SSE, streamable HTTP.
  - Limitation: a fresh session per evaluation and a two-pass "call one tool, then answer" loop, so it does not model multi-turn agent sessions (overview, then zoom, then edit).
- **DSPy**: the gepa repo's `DspyAdapter` has `enable_tool_optimization: bool = False`, which rewrites `tool.desc` and argument descriptions; source comment says only ReAct modules are supported. https://github.com/gepa-ai/gepa/blob/main/src/gepa/adapters/dspy_adapter/dspy_adapter.py
  It is not in the `dspy.GEPA.__init__` signature on DSPy main (checked `dspy/teleprompt/gepa/gepa.py`), so DSPy users would have to reach it via the adapter. https://github.com/stanfordnlp/dspy/blob/main/dspy/teleprompt/gepa/gepa.py
  The DSPy metric returns a float or `dspy.Prediction(score=..., feedback=...)`. https://dspy.ai/current/api/optimizers/GEPA/overview/

## 2. JEPA

- I-JEPA / V-JEPA / V-JEPA 2: self-supervised vision/video encoders that predict representations in latent space; nothing about text formats.
- LLM-JEPA (Huang, LeCun, Balestriero, arXiv 2509.14252, v2 Oct 2025): adds a JEPA loss on paired views (NL to regex, NL to SQL, issue to diff) during finetuning/pretraining.
  It needs last-layer hidden states, a custom attention mask and gradients, so weights access; training compute about 2x; inference unchanged.
  It does not discuss graphs, workflows or compression, and is not usable through a closed API. https://arxiv.org/html/2509.14252v2
- Graph-JEPA (Skenderi et al., arXiv 2309.16014, TMLR 2025): learns graph-level embeddings by predicting masked-subgraph latents; outputs vectors for graph classification/regression, not LLM-readable text. https://arxiv.org/abs/2309.16014
- VL-JEPA (Chen et al., arXiv 2512.10942, ICLR 2026): predicts text embeddings instead of tokens; its authors say tool use and agentic behavior still need evaluation. https://arxiv.org/abs/2512.10942

Honest conclusion: JEPA could at most inspire an embedding index for "find similar nodes/subflows" retrieval, which any off-the-shelf embedding model already does.
It does not help design the overview format, the DSL, or tool descriptions for Claude.

## 3. Recommendation for this project

Use GEPA `optimize_anything`, not the MCP adapter, because n8n tasks are multi-turn (overview, then zoom, then edit, then validate) and the adapter only does one tool call.

- **What to optimize** (one candidate dict, round-robin over components): each MCP tool description; the DSL cheat-sheet text shown to the agent; optionally the overview render template if it is expressed as text.
  Keep the DSL grammar and parser fixed; GEPA should tune how they are explained, not the language.
- **Dataset**: 30-60 realistic tasks over real workflows of different sizes ("what happens after the IF on false?", "add a Set node after Webhook mapping X", "fix the broken expression in node Y"), split train/val about 50/50, plus a held-out test set.
- **Metric** (per rollout, run the real agent against the real MCP server with the candidate text injected):
  score = task success (checked by `n8n_validate_workflow` plus a structural diff against the expected workflow) minus a small penalty per 1k tokens and per failed/redundant tool call.
  Feedback via `oa.log`/info: validator errors, wrong tool chosen, tokens used, which nodes the agent zoomed into versus needed.
  Token cost and success can instead be separate objectives through the Pareto frontier (`frontier_type`), which avoids hand-tuning the penalty weight; not verified how `optimize_anything` expects multi-objective scores.
- **Budget**: start at `max_metric_calls` 150-300 (about 5-10 val passes of 30 tasks); each call is one full agent rollout, so measure tokens per rollout first and multiply.
  The paper's 1.8k-7k rollouts are for whole multi-module programs; a handful of descriptions should need far fewer.
  Turn on `cache_evaluation=True`.
- **Guardrails**: evaluate the winner on the held-out test set and on a second model (e.g. Sonnet vs Haiku) to catch overfitting to one model's quirks; keep the human-written seed as baseline.
