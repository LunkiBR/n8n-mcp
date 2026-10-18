import { describe, it, expect } from 'vitest';
import { buildGraph, aiRoot } from '@/lens/graph';
import { detectRegions } from '@/lens/regions';
import { createLensContext, inspect } from '@/lens';
import { outputLabel } from '@/lens/render';
import { outputsFromExecution } from '@/lens/schema';
import { connect, hiddenDependencyWorkflow, node } from './fixtures';
import { Workflow } from '@/types/n8n-api';

function sticky(name: string, content: string, position: [number, number], width: number, height: number) {
  return node(name, 'stickyNote', { content, width, height }, { position });
}

describe('lens regions', () => {
  it('uses a sticky note that frames at least two nodes, named by its first line', () => {
    const a = node('A', 'manualTrigger', {}, { position: [100, 100] });
    const b = node('B', 'set', {}, { position: [300, 100] });
    const c = node('C', 'set', {}, { position: [900, 100] });
    const d = node('D', 'set', {}, { position: [1100, 100] });
    const wf: Workflow = {
      name: 'w',
      nodes: [a, b, c, d, sticky('S1', '## Step 1: Ingest\nsome text', [0, 0], 500, 300), sticky('S2', 'Configure me', [880, 80], 100, 100)],
      connections: connect([['A', 'B'], ['B', 'C'], ['C', 'D']]),
    };
    const { regions } = detectRegions(buildGraph(wf));
    expect(regions[0]).toMatchObject({ name: 'Step 1: Ingest', source: 'sticky', nodes: ['A', 'B'] });
    // The note around C alone is an instruction, not a section.
    expect(regions.find(r => r.nodes.includes('C'))?.source).toBe('auto');
  });

  it('prefers canvas groups over sticky notes', () => {
    const a = node('A', 'manualTrigger', {}, { position: [100, 100] });
    const b = node('B', 'set', {}, { position: [300, 100] });
    const wf: Workflow = {
      name: 'w',
      nodes: [a, b, sticky('S', '# Sticky', [0, 0], 500, 300)],
      connections: connect([['A', 'B']]),
      nodeGroups: [{ id: 'g1', name: 'Group One', nodeIds: [a.id, b.id] }],
    };
    expect(detectRegions(buildGraph(wf)).regions).toEqual([expect.objectContaining({ name: 'Group One', source: 'group', nodes: ['A', 'B'] })]);
  });

  it('keeps AI sub-nodes with the agent they serve', () => {
    const wf: Workflow = {
      name: 'w',
      nodes: [
        node('Chat', '@n8n/n8n-nodes-langchain.chatTrigger'),
        node('Agent', '@n8n/n8n-nodes-langchain.agent', { text: 'hi' }),
        node('Model', '@n8n/n8n-nodes-langchain.lmChatOpenAi', { model: 'gpt-4o-mini' }),
        node('Embed', '@n8n/n8n-nodes-langchain.embeddingsOpenAi'),
        node('Store Tool', '@n8n/n8n-nodes-langchain.vectorStoreInMemory'),
      ],
      connections: connect([
        ['Chat', 'Agent'],
        ['Model', 'Agent', 0, 'ai_languageModel'],
        ['Store Tool', 'Agent', 0, 'ai_tool'],
        ['Embed', 'Store Tool', 0, 'ai_embedding'],
      ]),
    };
    const graph = buildGraph(wf);
    expect(aiRoot(graph, 'Embed')).toBe('Agent');
    const { regionOf } = detectRegions(graph);
    expect(new Set(['Agent', 'Model', 'Embed', 'Store Tool'].map(n => regionOf.get(n)!.id)).size).toBe(1);
  });

  it('merges a lone trigger into the stage it starts', () => {
    const { regions } = detectRegions(buildGraph(hiddenDependencyWorkflow()));
    expect(regions).toHaveLength(1);
    expect(regions[0].nodes[0]).toBe('Webhook');
  });
});

describe('lens dependencies', () => {
  it('zoom on the last node surfaces the config node read by name five steps upstream', () => {
    const text = inspect(hiddenDependencyWorkflow(), { view: 'zoom', nodes: ['Notify'] });
    expect(text).toContain('name <- Set Config');
    expect(text).toContain('api_base');
    expect(text).toContain('input <- Is Gold');
  });

  it('traces a passed-through field to the node that sets it, statically', () => {
    const ctx = createLensContext(hiddenDependencyWorkflow());
    expect(ctx.deps.originOf('Notify', 'tier')).toMatchObject({ origin: 'Tag Tier', basis: 'static' });
  });

  it('uses run data to find the origin and to flag fields missing from the input', () => {
    const run = (json: Record<string, unknown>) => [{ data: { main: [[{ json }]] } }];
    const execution = {
      data: {
        resultData: {
          runData: {
            'Fetch Order': run({ id: 1, total: 120 }),
            'Tag Tier': run({ id: 1, total: 120, tier: 'gold' }),
            Normalize: run({ id: 1, total: 120, tier: 'gold', currency: 'EUR' }),
            'Is Gold': run({ id: 1, total: 120, tier: 'gold', currency: 'EUR' }),
          },
        },
      },
    };
    const outputs = outputsFromExecution(execution);
    const ctx = createLensContext(hiddenDependencyWorkflow(), outputs);
    expect(ctx.deps.originOf('Notify', 'tier')).toMatchObject({ origin: 'Tag Tier', basis: 'execution' });
    expect(ctx.deps.originOf('Notify', 'discount')).toMatchObject({ missing: true });
    const text = inspect(hiddenDependencyWorkflow(), { view: 'zoom', nodes: ['Notify'], outputs, outputsLabel: 'execution 1' });
    expect(text).toContain('discount (MISSING in last run input)');
    expect(text).toContain('tier (set by Tag Tier)');
  });

  it('lists who reads a node', () => {
    const text = inspect(hiddenDependencyWorkflow(), { view: 'zoom', nodes: ['Set Config'] });
    expect(text).toMatch(/read by: .*Fetch Order \(name: api_base\).*Notify \(name: api_base\)/);
  });

  it('reports references to nodes that do not exist', () => {
    const wf = hiddenDependencyWorkflow();
    wf.nodes.push(node('Broken', 'set', { assignments: { assignments: [{ name: 'x', value: "={{ $('Gone').item.json.y }}", type: 'string' }] } }));
    wf.connections['Notify'] = { main: [[{ node: 'Broken', type: 'main', index: 0 }]] };
    expect(inspect(wf, { view: 'zoom', nodes: ['Broken'] })).toContain('Gone: NOT FOUND');
  });
});

describe('lens views', () => {
  it('labels output ports the way the authoring notation names them', () => {
    expect(outputLabel(node('I', 'if'), 0)).toBe('true');
    expect(outputLabel(node('I', 'if'), 1)).toBe('false');
    expect(outputLabel(node('L', 'splitInBatches', {}, { typeVersion: 3 }), 1)).toBe('loop');
    expect(outputLabel(node('S', 'switch', { rules: { values: [{ outputKey: 'paid' }, { outputKey: 'open' }] } }), 1)).toBe('open');
    expect(outputLabel(node('H', 'httpRequest', {}, { onError: 'continueErrorOutput' }), 1)).toBe('error');
  });

  it('outline prints one line per node with summaries and edges', () => {
    const text = inspect(hiddenDependencyWorkflow(), { view: 'outline' });
    expect(text).toContain('- Webhook (webhook v1): POST /order -> Set Config');
    expect(text).toContain('- Is Gold (if v1): ={{ $json.tier }} equals gold true-> Notify');
  });

  it('find returns matches with their parameter path', () => {
    const text = inspect(hiddenDependencyWorkflow(), { view: 'find', query: 'api_base' });
    expect(text).toMatch(/^\d+ matches/);
    expect(text).toContain('Fetch Order url:');
  });

  it('rejects an unknown region with the list of regions', () => {
    expect(() => inspect(hiddenDependencyWorkflow(), { view: 'outline', region: 'R9' })).toThrow(/region "R9" not found; regions: R1/);
  });

  it('zoom lists incoming and outgoing connections in flow notation', () => {
    const text = inspect(hiddenDependencyWorkflow(), { view: 'zoom', nodes: ['Notify', 'Is Gold'] });
    expect(text).toContain('in: Is Gold.true');
    expect(text).toContain('out: true-> Notify');
    expect(text).toContain('out: none');
  });

  it('summarizes resource mapper column schemas unless full is asked for', () => {
    const wf = hiddenDependencyWorkflow();
    const schema = Array.from({ length: 30 }, (_, i) => ({ id: `col${i}`, displayName: `col${i}`, required: i === 0, removed: i > 9, type: 'string' }));
    wf.nodes.push(node('Save Row', 'airtable', { columns: { mappingMode: 'defineBelow', value: { col0: '={{ $json.id }}' }, schema } }));
    wf.connections['Notify'] = { main: [[{ node: 'Save Row', type: 'main', index: 0 }]] };
    const short = inspect(wf, { view: 'zoom', nodes: ['Save Row'] });
    expect(short).toContain('schema: 10 columns (+20 removed), required: col0');
    expect(short).toContain('col0: ={{ $json.id }}');
    expect(short).not.toContain('displayName');
    expect(inspect(wf, { view: 'zoom', nodes: ['Save Row'], full: true })).toContain('displayName');
  });
});


describe('lens dependencies with several inputs', () => {
  it('does not flag a field missing when another input that ran produced it', () => {
    const wf: Workflow = {
      name: 'w',
      nodes: [node('T', 'manualTrigger'), node('Left', 'set'), node('Right', 'set'), node('Join', 'merge'), node('Use', 'set', { assignments: { assignments: [{ name: 'x', value: '={{ $json.picked }}', type: 'string' }] } })],
      connections: connect([['T', 'Left'], ['T', 'Right'], ['Left', 'Use'], ['Right', 'Use']]),
    };
    const run = (json: Record<string, unknown>) => [{ data: { main: [[{ json }]] } }];
    const outputs = outputsFromExecution({ data: { resultData: { runData: { Left: run({ other: 1 }), Right: run({ picked: 2 }) } } } });
    const ctx = createLensContext(wf, outputs);
    expect(ctx.deps.originOf('Use', 'picked')).toMatchObject({ origin: 'Right', basis: 'execution' });
    const none = outputsFromExecution({ data: { resultData: { runData: { Left: run({ other: 1 }), Right: run({ other: 2 }) } } } });
    expect(createLensContext(wf, none).deps.originOf('Use', 'picked')).toMatchObject({ missing: true });
  });
});
