import { Workflow, WorkflowNode } from '@/types/n8n-api';

let counter = 0;

export function node(name: string, type: string, parameters: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode {
  counter++;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    name,
    type: type.includes('.') ? type : `n8n-nodes-base.${type}`,
    typeVersion: 1,
    position: [counter * 200, 0],
    parameters,
    ...extra,
  };
}

/** `[from, to, outputIndex?, type?]` tuples to n8n connections. */
export function connect(edges: Array<[string, string, number?, string?]>): Workflow['connections'] {
  const connections: Workflow['connections'] = {};
  for (const [from, to, output = 0, type = 'main'] of edges) {
    connections[from] ??= {};
    connections[from][type] ??= [];
    const outputs = connections[from][type];
    while (outputs.length <= output) outputs.push([]);
    outputs[output]!.push({ node: to, type, index: 0 });
  }
  return connections;
}

/**
 * Seven-step pipeline whose last node reads a value set in the second node by name, plus an
 * input field produced three hops upstream and passed through unchanged.
 */
export function hiddenDependencyWorkflow(): Workflow {
  const nodes = [
    node('Webhook', 'webhook', { path: 'order', httpMethod: 'POST' }),
    node('Set Config', 'set', { assignments: { assignments: [{ id: 'a', name: 'api_base', value: 'https://api.example.com', type: 'string' }] } }),
    node('Fetch Order', 'httpRequest', { method: 'GET', url: "={{ $('Set Config').item.json.api_base }}/orders/{{ $('Webhook').item.json.body.id }}" }),
    node('Tag Tier', 'code', { jsCode: "return items.map(item => ({ json: { ...item.json, tier: item.json.total > 100 ? 'gold' : 'std' } }));" }),
    node('Normalize', 'set', { includeOtherFields: true, assignments: { assignments: [{ id: 'b', name: 'currency', value: 'EUR', type: 'string' }] } }),
    node('Is Gold', 'if', { conditions: { combinator: 'and', conditions: [{ leftValue: '={{ $json.tier }}', rightValue: 'gold', operator: { type: 'string', operation: 'equals' } }] } }),
    node('Notify', 'httpRequest', { method: 'POST', url: "={{ $('Set Config').item.json.api_base }}/notify", jsonBody: '={{ { tier: $json.tier, missing: $json.discount } }}' }),
  ];
  return {
    id: 'wf1',
    name: 'Hidden dependency',
    nodes,
    connections: connect([
      ['Webhook', 'Set Config'],
      ['Set Config', 'Fetch Order'],
      ['Fetch Order', 'Tag Tier'],
      ['Tag Tier', 'Normalize'],
      ['Normalize', 'Is Gold'],
      ['Is Gold', 'Notify', 0],
    ]),
  };
}
