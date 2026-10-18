// Benchmark harness: prepares a run (fresh workflow copies on the local n8n) and grades it.
//
//   node bench/lens/harness.mjs setup <taskId> <runId>       -> prints JSON { workflowId?, ... }
//   node bench/lens/harness.mjs grade <taskId> <runId>       -> prints JSON { score, checks: [...] }
//   node bench/lens/harness.mjs cleanup <runId>              -> deletes the run's workflows
//
// Run state lives in D:/n8nmcp/bench-runs/<runId>/ (state.json, answer.json, calls.jsonl).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const here = dirname(fileURLToPath(import.meta.url));
const RUNS = process.env.BENCH_RUNS ?? 'D:/n8nmcp/bench-runs';
const env = Object.fromEntries(readFileSync('D:/n8nmcp/testbed/testbed.env', 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const BASE = env.N8N_TESTBED_URL;
const headers = { 'X-N8N-API-KEY': env.N8N_API_KEY, 'content-type': 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, path, body) {
  const res = await fetch(`${BASE}/api/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const runDir = runId => join(RUNS, runId);
const loadState = runId => JSON.parse(readFileSync(join(runDir(runId), 'state.json'), 'utf8'));
const saveState = (runId, state) => writeFileSync(join(runDir(runId), 'state.json'), JSON.stringify(state, null, 2));
const fixture = name => JSON.parse(readFileSync(join(here, 'fixtures', `${name}.json`), 'utf8'));
const slug = runId => runId.toLowerCase().replace(/[^a-z0-9]+/g, '-');

const ORDERS = { orders: [
  { sku: 'a-1', region: 'EU', amount: 300 },
  { sku: 'b-2', region: 'us', amount: 1000 },
  { sku: 'c-3', region: 'br', amount: 50 },
  { sku: 'a-1', region: 'eu', amount: 700 },
] };
const EXPECTED_TOTAL = 2088;

async function copyTemplate(name, runId) {
  const fx = fixture(name);
  const wf = await api('POST', '/workflows', { name: `[${runId}] ${fx.name}`.slice(0, 128), nodes: fx.nodes, connections: fx.connections, settings: { executionOrder: 'v1' } });
  return wf.id;
}

async function triggerWebhook(path, payload) {
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`${BASE}/webhook/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if (res.ok) return;
    await sleep(1000);
  }
  throw new Error(`webhook ${path} never registered`);
}

async function latestExecution(workflowId, after = 0) {
  for (let i = 0; i < 30; i++) {
    const list = await api('GET', `/executions?workflowId=${workflowId}&limit=1&includeData=true`);
    const ex = list.data?.[0];
    if (ex && Number(ex.id) > after && ex.finished !== false && ex.status !== 'running' && ex.status !== 'new') return ex;
    await sleep(1000);
  }
  throw new Error('no execution');
}

/** Creates the order pipeline (with its planted bug) from its compact spec and runs it once. */
async function setupOrderPipeline(runId, path) {
  const spec = JSON.parse(readFileSync(join(here, 'fixtures-exec', 'order-pipeline.compose.json'), 'utf8').replace('__PATH__', path));
  spec.name = `[${runId}] Order pipeline`;
  const out = spawnSync(process.execPath, [join(here, 'agent-tool.mjs'), 'n8n_compose_workflow', JSON.stringify(spec)], { encoding: 'utf8', env: { ...process.env, BENCH_CONDITION: 'fork', BENCH_LOG: '' } });
  const id = /id=([A-Za-z0-9]+)/.exec(out.stdout)?.[1];
  if (!id) throw new Error(`setup failed: ${out.stdout} ${out.stderr}`);
  await api('POST', `/workflows/${id}/activate`);
  await triggerWebhook(path, ORDERS);
  await latestExecution(id);
  return id;
}

const TASKS = {
  'dm-credentials': { setup: async runId => ({ workflowId: await copyTemplate('template-7311', runId) }) },
  'drive-folders': { setup: async runId => ({ workflowId: await copyTemplate('template-13245', runId) }) },
  'agent-wiring': { setup: async runId => ({ workflowId: await copyTemplate('template-9100', runId) }) },
  'edit-content-engine': { setup: async runId => ({ workflowId: await copyTemplate('template-9100', runId) }) },
  'fix-discount': {
    setup: async runId => {
      const path = `orders-${slug(runId)}`;
      return { workflowId: await setupOrderPipeline(runId, path), path };
    },
  },
  'create-support-triage': { setup: async runId => ({ workflowName: `[${runId}] Support Triage`, path: `support-${slug(runId)}` }) },
};

// ---------------------------------------------------------------------------------------------
// Grading

const norm = s => String(s ?? '').trim().toLowerCase();
const sameSet = (a, b) => {
  const x = new Set((a ?? []).map(norm));
  const y = new Set((b ?? []).map(norm));
  return x.size === y.size && [...x].every(v => y.has(v));
};

function readAnswer(runId) {
  const file = join(runDir(runId), 'answer.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function outEdges(wf, from, type = 'main') {
  return (wf.connections?.[from]?.[type] ?? []).map((targets, output) => (targets ?? []).map(t => ({ output, to: t.node, input: t.index ?? 0 }))).flat();
}

const byName = wf => Object.fromEntries(wf.nodes.map(n => [n.name, n]));
const stable = value => JSON.stringify(value, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v));

const GRADERS = {
  'dm-credentials': async runId => {
    const a = readAnswer(runId) ?? {};
    return [
      ['sender_node', norm(a.sender_node) === norm('Send DM Message')],
      ['credentials_source_node', norm(a.credentials_source_node) === norm('Get Lead Data - Active Campaign')],
      ['text_source_node', norm(a.text_source_node) === norm('Lead Data - DM Personalization')],
      ['endpoint_path', norm(a.endpoint_path).endsWith('/api/v1/chats')],
    ];
  },
  'drive-folders': async runId => {
    const a = readAnswer(runId) ?? {};
    return [
      ['login_nodes', sameSet(a.login_nodes, ['n8n login API1', 'n8n login API2'])],
      ['login_path', norm(a.login_path).endsWith('/rest/login')],
      ['folder_nodes', sameSet(a.folder_creating_nodes, ['Create folder under the parentFolder', 'Create folder under the static "backup_n8n" folder', 'Create backup folder "n8n_backup_folder_structure_ddMMyyyy_HHmmss"'])],
    ];
  },
  'agent-wiring': async runId => {
    const a = readAnswer(runId) ?? {};
    return [
      ['models', sameSet(a.models, ['deepseek/deepseek-chat-v3-0324:free', 'models/gemini-2.5-pro'])],
      ['tool_node', norm(a.tool_node) === norm('Reasearch')],
      ['tool_target_workflow', norm(a.tool_target_workflow) === norm('Helper for SMS') || norm(a.tool_target_workflow) === norm('SrUy5WyflJfrWop0')],
      ['output_keys', sameSet(a.output_parser_keys, ['intro', 'text', 'image_description'])],
    ];
  },
  'edit-content-engine': async runId => {
    const state = loadState(runId);
    const before = fixture('template-9100');
    const after = await api('GET', `/workflows/${state.workflowId}`);
    const b = byName(before);
    const n = byName(after);
    const ping = n['Ping Analytics'];
    const checks = [
      ['ping_exists', !!ping && ping.type === 'n8n-nodes-base.httpRequest'],
      ['ping_post_url', !!ping && norm(ping.parameters?.method) === 'post' && norm(ping.parameters?.url).replace(/^=/, '') === 'https://example.com/analytics'],
      ['ping_after_save_post', outEdges(after, 'Save Post').some(e => e.to === 'Ping Analytics' && e.output === 0)],
      ['save_post_edges_kept', outEdges(before, 'Save Post').every(e => outEdges(after, 'Save Post').some(x => x.to === e.to && x.output === e.output))],
      ['gemini_timeout', Number(n['HTTP- Gemini']?.parameters?.options?.timeout) === 30000],
    ];
    const gemini = { ...(n['HTTP- Gemini']?.parameters ?? {}) };
    const geminiBefore = { ...(b['HTTP- Gemini']?.parameters ?? {}) };
    if (gemini.options) gemini.options = Object.fromEntries(Object.entries(gemini.options).filter(([k]) => k !== 'timeout'));
    if (geminiBefore.options) geminiBefore.options = Object.fromEntries(Object.entries(geminiBefore.options).filter(([k]) => k !== 'timeout'));
    const untouched = before.nodes.filter(x => x.name !== 'HTTP- Gemini').every(x => n[x.name] && stable(n[x.name].parameters) === stable(x.parameters) && n[x.name].type === x.type);
    checks.push(['gemini_rest_unchanged', stable(gemini) === stable(geminiBefore)]);
    checks.push(['other_nodes_unchanged', untouched && after.nodes.length === before.nodes.length + 1]);
    const otherConnections = Object.keys(before.connections).filter(k => k !== 'Save Post').every(k => stable(after.connections[k]) === stable(before.connections[k]));
    checks.push(['other_connections_unchanged', otherConnections]);
    return checks;
  },
  'fix-discount': async runId => {
    const state = loadState(runId);
    const draft = await api('GET', `/workflows/${state.workflowId}`);
    // Run the agent's draft as its own copy so the check does not depend on publishing.
    const path = `${state.path}-check`;
    const nodes = draft.nodes.map(x => (x.type === 'n8n-nodes-base.webhook' ? { ...x, webhookId: crypto.randomUUID(), parameters: { ...x.parameters, path } } : x));
    const copy = await api('POST', '/workflows', { name: `[${runId}] grade copy`, nodes, connections: draft.connections, settings: { executionOrder: 'v1' } });
    let total;
    let discounted = [];
    try {
      await api('POST', `/workflows/${copy.id}/activate`);
      await triggerWebhook(path, ORDERS);
      const ex = await latestExecution(copy.id);
      const run = ex.data?.resultData?.runData ?? {};
      const summary = run['Summarize']?.[0]?.data?.main?.[0]?.[0]?.json;
      total = summary?.total;
      const apply = Object.values(run).flatMap(r => r.at(-1)?.data?.main?.[0] ?? []).map(i => i.json).filter(j => 'total_after_discount' in j);
      discounted = apply.map(j => j.total_after_discount);
    } finally {
      await api('POST', `/workflows/${copy.id}/deactivate`).catch(() => {});
      await api('DELETE', `/workflows/${copy.id}`).catch(() => {});
    }
    const a = readAnswer(runId) ?? {};
    return [
      ['root_cause_node', ['config', 'apply discount'].includes(norm(a.root_cause_node))],
      ['totals_numeric', discounted.length > 0 && discounted.every(v => typeof v === 'number' && Number.isFinite(v))],
      ['summary_total_correct', Math.abs(Number(total) - EXPECTED_TOTAL) < 0.01],
      ['node_count_kept', draft.nodes.length === 28],
    ];
  },
  'create-support-triage': async runId => {
    const state = loadState(runId);
    const list = await api('GET', `/workflows?limit=250`);
    const meta = list.data.find(w => w.name === state.workflowName);
    if (!meta) return [['exists', false]];
    const wf = await api('GET', `/workflows/${meta.id}`);
    const n = byName(wf);
    const ofType = t => wf.nodes.filter(x => x.type === t);
    const url = x => norm(x?.parameters?.url).replace(/^=/, '');
    const httpTo = u => wf.nodes.find(x => x.type === 'n8n-nodes-base.httpRequest' && url(x) === u);
    const hook = ofType('n8n-nodes-base.webhook')[0];
    const agent = ofType('@n8n/n8n-nodes-langchain.agent')[0];
    const aiFrom = (type, port) => wf.nodes.find(x => x.type === type && outEdges(wf, x.name, port).some(e => e.to === agent?.name));
    const model = aiFrom('@n8n/n8n-nodes-langchain.lmChatOpenAi', 'ai_languageModel');
    const modelName = model ? norm(model.parameters?.model?.value ?? model.parameters?.model) : '';
    const sw = ofType('n8n-nodes-base.switch')[0];
    const billing = httpTo('https://example.com/billing');
    const bugs = httpTo('https://example.com/bugs');
    const pager = httpTo('https://example.com/pager');
    const backlog = httpTo('https://example.com/backlog');
    const swTargets = sw ? outEdges(wf, sw.name).map(e => e.to) : [];
    const urgent = wf.nodes.find(x => x.type === 'n8n-nodes-base.if' && outEdges(wf, x.name).some(e => e.output === 0 && e.to === pager?.name));
    const loop = ofType('n8n-nodes-base.splitInBatches')[0];
    const loopEdges = loop ? outEdges(wf, loop.name) : [];
    const loopBody = loopEdges.find(e => e.output === 1)?.to;
    const normalize = n['Normalize Ticket'];
    const fields = (normalize?.parameters?.assignments?.assignments ?? []).map(x => x.name);
    const validate = spawnSync(process.execPath, [join(here, 'agent-tool.mjs'), 'n8n_validate_workflow', JSON.stringify({ id: meta.id })], { encoding: 'utf8', env: { ...process.env, BENCH_CONDITION: 'upstream', BENCH_LOG: '' } });
    const errorCount = /"errorCount":\s*(\d+)/.exec(validate.stdout)?.[1];
    return [
      ['exists', true],
      ['webhook', !!hook && norm(hook.parameters?.httpMethod) === 'post' && norm(hook.parameters?.path) === norm(state.path)],
      ['normalize_fields', ['subject', 'body', 'customer_email'].every(f => fields.includes(f))],
      ['agent_model', !!agent && modelName.includes('gpt-4o-mini')],
      ['agent_parser', !!aiFrom('@n8n/n8n-nodes-langchain.outputParserStructured', 'ai_outputParser')],
      ['switch_routes', !!sw && !!billing && !!bugs && swTargets.includes(billing.name) && swTargets.includes(bugs.name) && swTargets.some(t => n[t]?.type === 'n8n-nodes-base.noOp')],
      ['bug_error_branch', !!bugs && bugs.onError === 'continueErrorOutput' && outEdges(wf, bugs.name).some(e => e.output === 1 && e.to === 'Bug Intake Failed')],
      ['urgent_gate', !!urgent && [billing, bugs].every(h => h && outEdges(wf, h.name).some(e => e.output === 0 && e.to === urgent.name))],
      ['schedule_hourly', ofType('n8n-nodes-base.scheduleTrigger').some(s => JSON.stringify(s.parameters).includes('hours')) && !!backlog],
      ['loop_wiring', !!loop && loopBody === 'Score' && outEdges(wf, 'Score').some(e => e.to === loop.name) && loopEdges.some(e => e.output === 0 && e.to === 'Backlog Done')],
      ['validates', errorCount === '0'],
    ];
  },
};

const [command, taskId, runId] = process.argv.slice(2);
if (command === 'setup') {
  mkdirSync(runDir(runId), { recursive: true });
  const state = { taskId, runId, ...(await TASKS[taskId].setup(runId)) };
  saveState(runId, state);
  console.log(JSON.stringify(state));
} else if (command === 'grade') {
  const checks = await GRADERS[taskId](runId);
  const passed = checks.filter(([, ok]) => ok).length;
  const result = { taskId, runId, score: passed / checks.length, success: passed === checks.length, checks: Object.fromEntries(checks) };
  writeFileSync(join(runDir(runId), 'grade.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} else if (command === 'cleanup') {
  const id = taskId;
  const list = await api('GET', '/workflows?limit=250');
  for (const wf of list.data.filter(w => w.name.startsWith(`[${id}]`))) {
    await api('POST', `/workflows/${wf.id}/deactivate`).catch(() => {});
    await api('DELETE', `/workflows/${wf.id}`);
  }
  console.log('cleaned');
} else {
  console.error('usage: harness.mjs setup|grade <taskId> <runId> | cleanup <runId>');
  process.exit(1);
}
