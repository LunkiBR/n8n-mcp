/**
 * Resolves the short node types agents write (`webhook`, `agent`, `lmChatOpenAi`) to the full
 * workflow type and its latest typeVersion, using the bundled node database.
 */

import { NodeRepository } from '../database/node-repository';
import { NodeTypeNormalizer } from '../utils/node-type-normalizer';
import { NotationError } from './notation';

export interface ResolvedType {
  /** Workflow form, e.g. `n8n-nodes-base.httpRequest`. */
  type: string;
  typeVersion: number;
  /** Webhook-style triggers need a webhookId so n8n registers their path. */
  isWebhook: boolean;
}

function latestVersion(raw: unknown): number {
  const versions = String(raw ?? '1').split(',').map(v => Number(v.trim())).filter(v => Number.isFinite(v));
  return versions.length ? Math.max(...versions) : 1;
}

export function resolveNodeType(repository: NodeRepository, written: string): ResolvedType {
  const value = written.trim();
  const candidates = value.includes('.')
    ? [value]
    : [`nodes-base.${value}`, `nodes-langchain.${value}`];
  for (const candidate of candidates) {
    const info = repository.getNode(candidate);
    if (info) {
      return { type: NodeTypeNormalizer.toWorkflowFormat(info.nodeType), typeVersion: latestVersion(info.version), isWebhook: info.isWebhook === true };
    }
  }
  const suggestions = repository.searchNodes(value, 'OR', 3).map((n: any) => n.nodeType?.replace(/^nodes-(base|langchain)\./, ''));
  throw new NotationError(`unknown node type "${written}"${suggestions.length ? `; closest: ${suggestions.join(', ')}` : ''}. Use search_nodes to find the type.`);
}
