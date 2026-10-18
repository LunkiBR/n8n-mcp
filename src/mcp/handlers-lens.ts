/**
 * Handlers for the workflow lens tools.
 *
 * `n8n_inspect_workflow` returns plain text views of a live workflow (see src/lens). Success
 * results are strings so the server sends them as-is instead of pretty-printed JSON.
 */

import { z } from 'zod';
import { getN8nApiClient } from './handlers-n8n-manager';
import { InstanceContext } from '../types/instance-context';
import { McpToolResponse, Workflow } from '../types/n8n-api';
import { N8nApiError, getUserFriendlyErrorMessage } from '../utils/n8n-errors';
import { inspect, LensInputError, NodeOutput, outputsFromExecution } from '../lens';
import { logger } from '../utils/logger';

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
  if (error instanceof LensInputError) {
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
