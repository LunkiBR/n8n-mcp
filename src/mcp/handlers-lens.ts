/**
 * Handlers for the workflow lens tools.
 *
 * `n8n_inspect_workflow` returns plain text views of a live workflow (see src/lens).
 * `n8n_compose_workflow` creates or extends a workflow from compact notation (see src/compose),
 * writing through the existing create handler and diff engine.
 * Success results are strings so the server sends them as-is instead of pretty-printed JSON.
 */

import { z } from 'zod';
import { getN8nApiClient } from './handlers-n8n-manager';
import { InstanceContext } from '../types/instance-context';
import { McpToolResponse, Workflow } from '../types/n8n-api';
import { N8nApiError, getUserFriendlyErrorMessage } from '../utils/n8n-errors';
import { inspect, LensInputError, NodeOutput, outputsFromExecution } from '../lens';
import { logger } from '../utils/logger';
import { normalizeMcpJsonValue } from '../utils/mcp-input-normalizer';
import { NodeRepository } from '../database/node-repository';
import { WorkflowValidator, WorkflowValidationResult } from '../services/workflow-validator';
import { EnhancedConfigValidator } from '../services/enhanced-config-validator';
import { compileCreate, compileExtend, ComposeSpec } from '../compose/compile';
import { NotationError } from '../compose/notation';
import { handleCreateWorkflow } from './handlers-n8n-manager';
import { handleUpdatePartialWorkflow } from './handlers-workflow-diff';

const inspectSchema = z.object({
  id: z.string().min(1),
  view: z.enum(['overview', 'outline', 'zoom', 'find']).default('overview'),
  nodes: z.array(z.string()).optional(),
  region: z.string().optional(),
  query: z.string().optional(),
  full: z.boolean().optional(),
  executionId: z.string().optional(),
  runData: z.boolean().optional(),
});

function errorResponse(error: unknown): McpToolResponse {
  if (error instanceof z.ZodError) {
    return { success: false, error: 'Invalid input', details: { errors: error.errors } };
  }
  if (error instanceof N8nApiError) {
    return { success: false, error: getUserFriendlyErrorMessage(error), code: error.code };
  }
  if (error instanceof LensInputError || error instanceof NotationError) {
    return { success: false, error: error.message };
  }
  return { success: false, error: error instanceof Error ? error.message : 'Unknown error occurred' };
}

/**
 * Output schemas from the chosen execution, or the latest one of the workflow. Missing run data
 * is not an error: the zoom then says so and falls back to parameters.
 */
async function loadRunData(
  client: NonNullable<ReturnType<typeof getN8nApiClient>>,
  workflowId: string,
  executionId?: string
): Promise<{ outputs?: Map<string, NodeOutput>; label?: string }> {
  try {
    let id = executionId;
    if (!id) {
      const list = await client.listExecutions({ workflowId, limit: 1 });
      id = list.data?.[0]?.id;
    }
    if (!id) return {};
    const execution = await client.getExecution(String(id), true);
    const outputs = outputsFromExecution(execution);
    return { outputs, label: `execution ${id} (${execution.status ?? (execution.finished ? 'success' : 'unknown')}${execution.startedAt ? `, ${String(execution.startedAt).slice(0, 16)}` : ''})` };
  } catch (error) {
    if (executionId) throw error;
    logger.debug('Lens: no run data for workflow', { workflowId, error: error instanceof Error ? error.message : error });
    return {};
  }
}

export async function handleInspectWorkflow(args: unknown, context?: InstanceContext): Promise<McpToolResponse | string> {
  try {
    const input = inspectSchema.parse(args);
    const client = getN8nApiClient(context);
    if (!client) throw new Error('n8n API not configured. Please set N8N_API_URL and N8N_API_KEY environment variables.');

    const workflow = (await client.getWorkflow(input.id)) as Workflow;
    const wantsRunData = input.view === 'zoom' && input.runData !== false;
    const run = wantsRunData ? await loadRunData(client, input.id, input.executionId) : {};

    return inspect(workflow, {
      view: input.view,
      nodes: input.nodes,
      region: input.region,
      query: input.query,
      full: input.full,
      outputs: run.outputs,
      outputsLabel: run.label,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

const json = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(normalizeMcpJsonValue, schema);

const composeSchema = z.object({
  workflowId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  nodes: json(z.record(z.string(), json(z.object({
    type: z.string().optional(),
    v: z.number().optional(),
    params: json(z.record(z.string(), z.unknown())).optional(),
    credentials: json(z.record(z.string(), z.unknown())).optional(),
    position: json(z.tuple([z.number(), z.number()])).optional(),
    disabled: z.boolean().optional(),
    onError: z.enum(['continueRegularOutput', 'continueErrorOutput', 'stopWorkflow']).optional(),
    notes: z.string().optional(),
    retryOnFail: z.boolean().optional(),
    maxTries: z.number().optional(),
    waitBetweenTries: z.number().optional(),
    alwaysOutputData: z.boolean().optional(),
    executeOnce: z.boolean().optional(),
  }).strict()))).optional(),
  flow: json(z.array(z.string())).optional(),
  remove: json(z.array(z.string())).optional(),
  unlink: json(z.array(z.string())).optional(),
  settings: json(z.record(z.string(), z.unknown())).optional(),
});

const MAX_WARNINGS = 8;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const issueKey = (issue: { nodeName?: string; message: string }) => `${issue.nodeName ?? ''}\u0000${issue.message}`;

/**
 * Validation summary. With `before`, only issues the change introduced are listed; issues the
 * workflow already had are counted, since repeating them on every edit buries the new ones.
 */
function formatValidation(result: WorkflowValidationResult, before?: WorkflowValidationResult): string {
  const known = new Set([...(before?.errors ?? []), ...(before?.warnings ?? [])].map(issueKey));
  const errors = result.errors.filter(i => !known.has(issueKey(i)));
  const warnings = result.warnings.filter(i => !known.has(issueKey(i)));
  const oldErrors = result.errors.length - errors.length;
  const oldWarnings = result.warnings.length - warnings.length;
  const preexisting = oldErrors || oldWarnings ? `; already present before this change: ${plural(oldErrors, 'error')}, ${plural(oldWarnings, 'warning')}` : '';
  if (errors.length === 0 && warnings.length === 0) return `validation: ok${before ? ' (no new issues)' : ''}${preexisting}`;
  const lines = [`validation: ${plural(errors.length, before ? 'new error' : 'error')}, ${plural(warnings.length, before ? 'new warning' : 'warning')}${preexisting}`];
  for (const issue of errors) lines.push(`  error ${issue.nodeName ?? 'workflow'}: ${issue.message}`);
  for (const issue of warnings.slice(0, MAX_WARNINGS)) lines.push(`  warn  ${issue.nodeName ?? 'workflow'}: ${issue.message}`);
  if (warnings.length > MAX_WARNINGS) lines.push(`  +${warnings.length - MAX_WARNINGS} more warnings (n8n_validate_workflow lists all)`);
  return lines.join('\n');
}

async function validate(workflow: Workflow, repository: NodeRepository): Promise<WorkflowValidationResult> {
  const validator = new WorkflowValidator(repository, EnhancedConfigValidator);
  return validator.validateWorkflow(workflow as any, { profile: 'runtime' });
}

const NEXT = (id: string) =>
  `next: n8n_inspect_workflow id=${id} view=outline to review | to fix or extend, call n8n_compose_workflow with workflowId=${id} and only the nodes/flow that change`;

export async function handleComposeWorkflow(args: unknown, repository: NodeRepository, context?: InstanceContext): Promise<McpToolResponse | string> {
  try {
    const spec = composeSchema.parse(args) as ComposeSpec;

    if (!spec.workflowId) {
      const plan = compileCreate(spec, repository);
      const validation = await validate(plan.workflow as Workflow, repository);
      const created = await handleCreateWorkflow(plan.workflow, context);
      if (!created.success) return created;
      const id = String((created.data as { id: string }).id);
      return [
        `created "${plan.workflow.name}" id=${id}: ${plan.workflow.nodes.length} nodes, ${plan.edges.length} connections`,
        formatValidation(validation),
        NEXT(id),
      ].join('\n');
    }

    const client = getN8nApiClient(context);
    if (!client) throw new Error('n8n API not configured. Please set N8N_API_URL and N8N_API_KEY environment variables.');
    const current = (await client.getWorkflow(spec.workflowId)) as Workflow;
    const plan = compileExtend(spec, current, repository);
    if (plan.operations.length === 0) return `nothing to change in "${current.name}" id=${spec.workflowId}`;
    const before = await validate(current, repository);

    const applied = await handleUpdatePartialWorkflow({ id: spec.workflowId, operations: plan.operations }, repository, context);
    if (!applied.success) return applied;
    const updated = (await client.getWorkflow(spec.workflowId)) as Workflow;
    const parts = [
      plan.added.length ? `added ${plan.added.join(', ')}` : '',
      plan.updated.length ? `updated ${plan.updated.join(', ')}` : '',
      plan.removed.length ? `removed ${plan.removed.join(', ')}` : '',
      plan.linked ? `+${plan.linked} connections` : '',
      plan.unlinked ? `-${plan.unlinked} connections` : '',
    ].filter(Boolean);
    return [
      `updated "${updated.name}" id=${spec.workflowId}: ${parts.join('; ')} (${updated.nodes.length} nodes now)`,
      formatValidation(await validate(updated, repository), before),
      NEXT(spec.workflowId),
    ].join('\n');
  } catch (error) {
    return errorResponse(error);
  }
}
