import { describe, it, expect } from 'vitest';
import { introducedStructureErrors, validateWorkflowStructure } from '@/services/n8n-validation';
import { Workflow } from '@/types/n8n-api';

const n = (name: string, type = 'n8n-nodes-base.set') => ({ id: name, name, type, typeVersion: 1, position: [0, 0] as [number, number], parameters: {} });

const base: Workflow = {
  name: 'w',
  nodes: [n('Start', 'n8n-nodes-base.manualTrigger'), n('A'), n('Orphan')],
  connections: { Start: { main: [[{ node: 'A', type: 'main', index: 0 }]] } },
};

describe('introducedStructureErrors', () => {
  it('ignores a disconnected node the workflow already had', () => {
    const after: Workflow = { ...base, nodes: [...base.nodes, n('B')], connections: { ...base.connections, A: { main: [[{ node: 'B', type: 'main', index: 0 }]] } } };
    const errors = validateWorkflowStructure(after);
    expect(errors.some(e => e.includes('"Orphan"'))).toBe(true);
    expect(introducedStructureErrors(base, errors, after)).toEqual([]);
  });

  it('still blocks a node the edit leaves disconnected', () => {
    const after: Workflow = { ...base, nodes: [...base.nodes, n('New')] };
    expect(introducedStructureErrors(base, validateWorkflowStructure(after), after)).toHaveLength(1);
  });

  it('keeps every error when there is no snapshot of the workflow before the edit', () => {
    const errors = validateWorkflowStructure(base);
    expect(introducedStructureErrors(null, errors)).toEqual(errors);
  });

  it('recognizes pre-existing orphans whose names contain quotes and parentheses', () => {
    const odd = n('Model "fast" (backup). Each node');
    const before: Workflow = { ...base, nodes: [...base.nodes.filter(x => x.name !== 'Orphan'), odd] };
    const after: Workflow = { ...before, nodes: [...before.nodes, n('B')], connections: { ...before.connections, A: { main: [[{ node: 'B', type: 'main', index: 0 }]] } } };
    expect(introducedStructureErrors(before, validateWorkflowStructure(after), after)).toEqual([]);
  });
});
