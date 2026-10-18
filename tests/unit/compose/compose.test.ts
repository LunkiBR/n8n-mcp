import { describe, it, expect } from 'vitest';
import { parseFlow, NotationError } from '@/compose/notation';
import { compileCreate, compileExtend } from '@/compose/compile';
import { layoutWorkflow } from '@/compose/layout';
import { NodeRepository } from '@/database/node-repository';
import { Workflow } from '@/types/n8n-api';

const KNOWN: Record<string, { version: string; isWebhook?: boolean }> = {
  'nodes-base.webhook': { version: '2.2', isWebhook: true },
  'nodes-base.set': { version: '3.4' },
  'nodes-base.if': { version: '2.2' },
  'nodes-base.code': { version: '2' },
  'nodes-base.httpRequest': { version: '4.2' },
  'nodes-base.splitInBatches': { version: '3' },
  'nodes-base.noOp': { version: '1' },
  'nodes-langchain.agent': { version: '2.1' },
  'nodes-langchain.lmChatOpenAi': { version: '1.2' },
};

const repository = {
  getNode(type: string) {
    const key = Object.keys(KNOWN).find(k => k.toLowerCase() === type.toLowerCase());
    return key ? { nodeType: key, version: KNOWN[key].version, isWebhook: KNOWN[key].isWebhook === true } : null;
  },
  searchNodes() {
    return [{ nodeType: 'nodes-base.httpRequest' }];
  },
} as unknown as NodeRepository;

const node = (type: string, extra: Record<string, unknown> = {}) => ({ type, typeVersion: 1, parameters: {}, ...extra });

describe('flow notation', () => {
  const nodes = new Map<string, any>([
    ['A', node('n8n-nodes-base.webhook')],
    ['Is Hot', node('n8n-nodes-base.if')],
    ['Loop', node('n8n-nodes-base.splitInBatches', { typeVersion: 3 })],
    ['HTTP', node('n8n-nodes-base.httpRequest', { onError: 'continueErrorOutput' })],
    ['Merge', node('n8n-nodes-base.merge')],
    ['Model', node('@n8n/n8n-nodes-langchain.lmChatOpenAi')],
    ['Agent', node('@n8n/n8n-nodes-langchain.agent')],
    ['v2.0 Step', node('n8n-nodes-base.set')],
  ]);

  it('parses chains, output labels, input indexes and AI ports', () => {
    const edges = parseFlow(
      ['A -> Is Hot', 'Is Hot.false -> Loop', 'Loop.loop -> HTTP', 'HTTP.error -> Merge[1]', 'HTTP.success -> v2.0 Step', 'Model =model=> Agent'],
      nodes
    );
    expect(edges).toEqual([
      { from: 'A', to: 'Is Hot', type: 'main', output: 0, input: 0 },
      { from: 'Is Hot', to: 'Loop', type: 'main', output: 1, input: 0 },
      { from: 'Loop', to: 'HTTP', type: 'main', output: 1, input: 0 },
      { from: 'HTTP', to: 'Merge', type: 'main', output: 1, input: 1 },
      { from: 'HTTP', to: 'v2.0 Step', type: 'main', output: 0, input: 0 },
      { from: 'Model', to: 'Agent', type: 'ai_languageModel', output: 0, input: 0 },
    ]);
  });

  it('matches names that contain dots before reading selectors', () => {
    expect(parseFlow(['v2.0 Step -> A'], nodes)[0]).toMatchObject({ from: 'v2.0 Step', output: 0 });
  });

  it('explains unknown nodes, outputs and ports', () => {
    expect(() => parseFlow(['A -> is hot'], nodes)).toThrow(/unknown node "is hot".*did you mean "Is Hot"/);
    expect(() => parseFlow(['Is Hot.maybe -> A'], nodes)).toThrow(/unknown output "maybe"/);
    expect(() => parseFlow(['Model =brain=> Agent'], nodes)).toThrow(/unknown AI port "brain"/);
    expect(() => parseFlow(['A'], nodes)).toThrow(NotationError);
  });
});

describe('compileCreate', () => {
  it('resolves short types to full types and latest versions, and wires connections', () => {
    const plan = compileCreate({
      name: 'W',
      nodes: {
        Hook: { type: 'webhook', params: { path: 'x' } },
        Check: { type: 'if' },
        Agent: { type: 'agent' },
        GPT: { type: 'lmChatOpenAi' },
      },
      flow: ['Hook -> Check', 'Check.true -> Agent', 'GPT =model=> Agent'],
    }, repository);
    const byName = Object.fromEntries(plan.workflow.nodes.map(n => [n.name, n]));
    expect(byName.Hook).toMatchObject({ type: 'n8n-nodes-base.webhook', typeVersion: 2.2, parameters: { path: 'x' } });
    expect(byName.Hook.webhookId).toMatch(/^[0-9a-f-]{36}$/);
    expect(byName.Agent).toMatchObject({ type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 2.1 });
    expect(plan.workflow.connections.Check.main[0]).toEqual([{ node: 'Agent', type: 'main', index: 0 }]);
    expect(plan.workflow.connections.GPT.ai_languageModel[0]).toEqual([{ node: 'Agent', type: 'ai_languageModel', index: 0 }]);
  });

  it('suggests a type when the short name is unknown', () => {
    expect(() => compileCreate({ name: 'W', nodes: { X: { type: 'http' } } }, repository)).toThrow(/unknown node type "http"; closest: httpRequest/);
  });
});

describe('layout', () => {
  it('places loop bodies after the loop node and never stacks two nodes', () => {
    const plan = compileCreate({
      name: 'W',
      nodes: { Hook: { type: 'webhook' }, Loop: { type: 'splitInBatches' }, Work: { type: 'code' }, Done: { type: 'noOp' }, Agent: { type: 'agent' }, GPT: { type: 'lmChatOpenAi' } },
      flow: ['Hook -> Loop', 'Loop.loop -> Work -> Loop', 'Loop.done -> Done -> Agent', 'GPT =model=> Agent'],
    }, repository);
    const pos = Object.fromEntries(plan.workflow.nodes.map(n => [n.name, n.position]));
    expect(pos.Loop[0]).toBeGreaterThan(pos.Hook[0]);
    expect(pos.Work[0]).toBeGreaterThan(pos.Loop[0]);
    expect(pos.GPT[1]).toBeGreaterThan(pos.Agent[1]);
    const keys = Object.values(pos).map(p => p.join(','));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps AI sub-nodes off the next row', () => {
    const positions = layoutWorkflow({
      names: ['T', 'A1', 'A2', 'M1'],
      edges: [
        { from: 'T', to: 'A1', type: 'main', output: 0, input: 0 },
        { from: 'T', to: 'A2', type: 'main', output: 0, input: 0 },
        { from: 'M1', to: 'A1', type: 'ai_languageModel', output: 0, input: 0 },
      ],
    });
    const [, a1y] = positions.get('A1')!;
    const [, a2y] = positions.get('A2')!;
    const [, m1y] = positions.get('M1')!;
    expect(Math.abs(m1y - a2y)).toBeGreaterThanOrEqual(100);
    expect(m1y).toBeGreaterThan(a1y);
  });
});

describe('compileExtend', () => {
  const existing: Workflow = {
    id: 'w1',
    name: 'W',
    nodes: [
      { id: '1', name: 'Hook', type: 'n8n-nodes-base.webhook', typeVersion: 2.2, position: [0, 0], parameters: { path: 'x' } },
      { id: '2', name: 'Save', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [260, 0], parameters: { url: 'https://a' } },
    ],
    connections: { Hook: { main: [[{ node: 'Save', type: 'main', index: 0 }]] } },
  };

  it('adds new nodes next to their neighbor, patches listed params, and skips existing edges', () => {
    const plan = compileExtend({
      workflowId: 'w1',
      nodes: { Save: { params: { url: 'https://b', 'options.timeout': 5000 } }, Notify: { type: 'httpRequest', params: { url: 'https://n' } } },
      flow: ['Hook -> Save -> Notify'],
    }, existing, repository);
    const add = plan.operations.find(o => o.type === 'addNode') as any;
    expect(add.node).toMatchObject({ name: 'Notify', type: 'n8n-nodes-base.httpRequest', position: [520, 0] });
    expect(plan.operations).toContainEqual({ type: 'updateNode', nodeName: 'Save', updates: { 'parameters.url': 'https://b', 'parameters.options.timeout': 5000 } });
    const links = plan.operations.filter(o => o.type === 'addConnection');
    expect(links).toEqual([expect.objectContaining({ source: 'Save', target: 'Notify', sourceIndex: 0 })]);
  });

  it('removes nodes and connections, and refuses type changes', () => {
    const plan = compileExtend({ workflowId: 'w1', remove: ['Save'], unlink: ['Hook -> Save'] }, existing, repository);
    expect(plan.operations.map(o => o.type)).toEqual(['removeNode']);
    expect(compileExtend({ workflowId: 'w1', unlink: ['Hook -> Save'] }, existing, repository).operations.map(o => o.type)).toEqual(['removeConnection']);
    expect(() => compileExtend({ workflowId: 'w1', nodes: { Save: { type: 'code' } } }, existing, repository)).toThrow(/to change its type, remove it/);
    expect(() => compileExtend({ workflowId: 'w1', unlink: ['Save -> Hook'] }, existing, repository)).toThrow(/no such connection/);
  });
});

describe('positionAddedNodes', () => {
  it('places a node added without a position next to the node it is wired from', async () => {
    const { positionAddedNodes } = await import('@/compose/layout');
    const nodes = [{ id: 'a', name: 'A', position: [100, 200] as [number, number] }];
    const ops: any[] = [
      { type: 'addNode', node: { name: 'B', type: 'n8n-nodes-base.set' } },
      { type: 'addConnection', source: 'a', target: 'B' },
    ];
    positionAddedNodes(nodes, ops);
    expect(ops[0].node.position).toEqual([360, 200]);
  });

  it('leaves positions the caller gave untouched', async () => {
    const { positionAddedNodes } = await import('@/compose/layout');
    const ops: any[] = [{ type: 'addNode', node: { name: 'B', position: [5, 5] } }];
    positionAddedNodes([], ops);
    expect(ops[0].node.position).toEqual([5, 5]);
  });
});

describe('summarizeChange', () => {
  it('lists added nodes, changed parameter paths and new edges, and nothing else', async () => {
    const { summarizeChange } = await import('@/compose/change-summary');
    const before: Workflow = {
      name: 'w',
      nodes: [
        { id: '1', name: 'A', type: 'n8n-nodes-base.set', typeVersion: 3, position: [0, 0], parameters: { options: {} } },
        { id: '2', name: 'B', type: 'n8n-nodes-base.httpRequest', typeVersion: 4, position: [260, 0], parameters: { url: 'x', options: {} } },
      ],
      connections: { A: { main: [[{ node: 'B', type: 'main', index: 0 }]] } },
    };
    const after: Workflow = {
      ...before,
      nodes: [
        before.nodes[0],
        { ...before.nodes[1], parameters: { url: 'x', options: { timeout: 5 } } },
        { id: '3', name: 'C', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [520, 0], parameters: {} },
      ],
      connections: { A: { main: [[{ node: 'B', type: 'main', index: 0 }]] }, B: { main: [[{ node: 'C', type: 'main', index: 0 }]] } },
    };
    expect(summarizeChange(before, after)).toBe('verified change (read back from n8n): +node C; ~B: options.timeout; +edge B -> C; every other node and connection is unchanged');
    expect(summarizeChange(before, before)).toMatch(/none/);
  });
});

describe('compileExtend unlink and re-link', () => {
  it('re-adds an edge that the same call unlinks', () => {
    const wf: Workflow = {
      id: 'w', name: 'W',
      nodes: [
        { id: '1', name: 'A', type: 'n8n-nodes-base.set', typeVersion: 3, position: [0, 0], parameters: {} },
        { id: '2', name: 'B', type: 'n8n-nodes-base.set', typeVersion: 3, position: [260, 0], parameters: {} },
      ],
      connections: { A: { main: [[{ node: 'B', type: 'main', index: 0 }]] } },
    };
    const plan = compileExtend({ workflowId: 'w', nodes: { X: { type: 'noOp' } }, unlink: ['A -> B'], flow: ['A -> X', 'A -> B'] }, wf, repository);
    const kinds = plan.operations.map(o => `${o.type}:${(o as any).source ?? ''}>${(o as any).target ?? ''}`);
    expect(kinds).toEqual(['removeConnection:A>B', 'addNode:>', 'addConnection:A>X', 'addConnection:A>B']);
  });
});
