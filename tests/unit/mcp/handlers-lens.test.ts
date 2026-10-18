import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hiddenDependencyWorkflow } from '../lens/fixtures';

const client = {
  getWorkflow: vi.fn(),
  listExecutions: vi.fn(),
  getExecution: vi.fn(),
};

vi.mock('@/mcp/handlers-n8n-manager', () => ({
  getN8nApiClient: () => client,
  handleCreateWorkflow: vi.fn(async (args: any) => ({ success: true, data: { id: 'new1', name: args.name } })),
}));
vi.mock('@/mcp/handlers-workflow-diff', () => ({
  handleUpdatePartialWorkflow: vi.fn(async () => ({ success: true, data: {} })),
}));
vi.mock('@/utils/logger');

import { handleInspectWorkflow, handleComposeWorkflow } from '@/mcp/handlers-lens';
import { handleCreateWorkflow } from '@/mcp/handlers-n8n-manager';
import { handleUpdatePartialWorkflow } from '@/mcp/handlers-workflow-diff';

const repository = {
  getNode: (type: string) => {
    const known: Record<string, string> = { 'nodes-base.set': '3.4', 'nodes-base.webhook': '2.2', 'nodes-base.noOp': '1' };
    const key = Object.keys(known).find(k => k.toLowerCase() === type.toLowerCase());
    return key ? { nodeType: key, version: known[key], isWebhook: key.endsWith('webhook') } : null;
  },
  searchNodes: () => [],
} as any;

const run = (json: Record<string, unknown>) => [{ data: { main: [[{ json }]] } }];

beforeEach(() => {
  vi.clearAllMocks();
  client.getWorkflow.mockResolvedValue({ ...hiddenDependencyWorkflow(), updatedAt: '2026-10-18T10:00:00.000Z' });
  client.listExecutions.mockResolvedValue({ data: [{ id: '7' }] });
  client.getExecution.mockResolvedValue({
    id: '7', status: 'success', startedAt: '2026-10-18T11:00:00.000Z',
    data: { resultData: { runData: { 'Is Gold': run({ tier: 'gold' }) } } },
  });
});

describe('handleInspectWorkflow', () => {
  it('returns the overview as text without loading run data', async () => {
    const text = await handleInspectWorkflow({ id: 'wf1' });
    expect(typeof text).toBe('string');
    expect(text).toContain('workflow "Hidden dependency"');
    expect(client.getExecution).not.toHaveBeenCalled();
  });

  it('zoom reads field types from the latest execution', async () => {
    const text = (await handleInspectWorkflow({ id: 'wf1', view: 'zoom', nodes: ['Notify'] })) as string;
    expect(text).toContain('run data: execution 7 (success');
    expect(text).toContain('discount (MISSING in last run input)');
    expect(text).not.toContain('ran before the last edit');
  });

  it('says when the execution is older than the last edit', async () => {
    client.getExecution.mockResolvedValue({ id: '7', status: 'success', startedAt: '2026-10-18T09:00:00.000Z', data: { resultData: { runData: {} } } });
    const text = (await handleInspectWorkflow({ id: 'wf1', view: 'zoom', nodes: ['Notify'] })) as string;
    expect(text).toContain('ran before the last edit');
  });

  it('reports a bad region as an error response', async () => {
    const result = (await handleInspectWorkflow({ id: 'wf1', view: 'outline', region: 'R42' })) as any;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/region "R42" not found/);
  });
});

describe('handleComposeWorkflow', () => {
  it('creates through the existing create handler and replies with a short summary', async () => {
    const text = (await handleComposeWorkflow({ name: 'W', nodes: { Hook: { type: 'webhook' }, Done: { type: 'noOp' } }, flow: ['Hook -> Done'] }, repository)) as string;
    expect(handleCreateWorkflow).toHaveBeenCalledWith(expect.objectContaining({ name: 'W', nodes: expect.any(Array) }), undefined);
    expect(text).toMatch(/^created "W" id=new1: 2 nodes, 1 connections/);
  });

  it('extends through the diff handler and reports the change read back from n8n', async () => {
    const before = hiddenDependencyWorkflow();
    const after = { ...before, nodes: [...before.nodes, { id: 'x', name: 'Audit', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [0, 0] as [number, number], parameters: {} }] };
    after.connections = { ...before.connections, Notify: { main: [[{ node: 'Audit', type: 'main', index: 0 }]] } };
    client.getWorkflow.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    const text = (await handleComposeWorkflow({ workflowId: 'wf1', nodes: { Audit: { type: 'noOp' } }, flow: ['Notify -> Audit'] }, repository)) as string;
    expect(handleUpdatePartialWorkflow).toHaveBeenCalledWith(expect.objectContaining({ id: 'wf1', operations: expect.any(Array) }), repository, undefined);
    expect(text).toContain('verified change (read back from n8n): +node Audit; +edge Notify -> Audit');
  });

  it('returns notation mistakes as an error response without writing', async () => {
    const result = (await handleComposeWorkflow({ name: 'W', nodes: { A: { type: 'noOp' } }, flow: ['A -> Missing'] }, repository)) as any;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unknown node "Missing"/);
    expect(handleCreateWorkflow).not.toHaveBeenCalled();
  });
});
