/**
 * One-line summaries of what a node does, read from its parameters.
 *
 * The outline view prints one line per node, so the summary has to say the most useful thing
 * about the node in a few dozen characters: the URL an HTTP node calls, the fields a Set node
 * writes, the condition an If node tests, the first line of a Code node.
 */

import { WorkflowNode } from '../types/n8n-api';

const MAX = 90;

export function clip(text: string, max = MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** `n8n-nodes-base.httpRequest` -> `httpRequest`; `@n8n/n8n-nodes-langchain.agent` -> `agent`. */
export function shortType(type: string): string {
  const base = type.startsWith('n8n-nodes-base.') || type.startsWith('@n8n/n8n-nodes-langchain.');
  return base ? type.slice(type.lastIndexOf('.') + 1) : type;
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function resourceLocator(value: unknown): string | undefined {
  if (value && typeof value === 'object' && '__rl' in (value as object)) {
    const rl = value as Record<string, unknown>;
    return str(rl.cachedResultName) ?? str(rl.value);
  }
  return str(value);
}

function conditionText(conditions: unknown): string | undefined {
  const list = (conditions as Record<string, unknown>)?.conditions;
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const combinator = str((conditions as Record<string, unknown>).combinator) ?? 'and';
  const parts = list.slice(0, 2).map((c: Record<string, unknown>) => {
    const op = (c.operator as Record<string, unknown>)?.operation ?? '?';
    const right = c.rightValue === undefined || c.rightValue === '' ? '' : ` ${str(c.rightValue) ?? JSON.stringify(c.rightValue)}`;
    return `${str(c.leftValue) ?? '?'} ${op}${right}`;
  });
  const more = list.length > 2 ? ` (+${list.length - 2})` : '';
  return parts.join(` ${combinator} `) + more;
}

function codeFirstLine(code: string): string {
  const lines = code.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('#') && !l.startsWith('/*') && !l.startsWith('*'));
  return `${code.split('\n').length} lines: ${lines[0] ?? ''}`;
}

/** A short, human-readable account of a node's configuration. Empty when nothing is worth saying. */
export function summarizeNode(node: WorkflowNode): string {
  const p = (node.parameters ?? {}) as Record<string, any>;
  const type = shortType(node.type);

  switch (type) {
    case 'code':
    case 'function':
    case 'functionItem': {
      const code = str(p.jsCode) ?? str(p.pythonCode) ?? str(p.functionCode) ?? '';
      return clip(codeFirstLine(code));
    }
    case 'httpRequest':
      return clip(`${str(p.method) ?? 'GET'} ${str(p.url) ?? ''}`);
    case 'webhook':
      return clip(`${str(p.httpMethod) ?? 'GET'} /${str(p.path) ?? ''}`);
    case 'set': {
      const assignments = p.assignments?.assignments;
      if (Array.isArray(assignments)) return clip(`sets ${assignments.map((a: any) => a.name).join(', ')}`);
      const values = p.values ? Object.values(p.values).flat() : [];
      if (values.length) return clip(`sets ${values.map((v: any) => v?.name).filter(Boolean).join(', ')}`);
      if (str(p.jsonOutput)) return clip(`json: ${p.jsonOutput}`);
      return '';
    }
    case 'if':
    case 'filter':
      return clip(conditionText(p.conditions) ?? '');
    case 'switch': {
      const rules = p.rules?.values ?? p.rules?.rules;
      if (Array.isArray(rules)) {
        const keys = rules.map((r: any, i: number) => r.outputKey ?? conditionText(r.conditions) ?? `#${i}`);
        return clip(`${rules.length} routes: ${keys.join(' | ')}`);
      }
      return clip(str(p.mode) ?? '');
    }
    case 'scheduleTrigger': {
      const rule = p.rule?.interval?.[0];
      if (!rule) return '';
      const field = rule.field ?? 'days';
      const every = rule[`${field}Interval`] ?? rule.expression ?? '';
      return clip(`every ${every} ${field}`.trim());
    }
    case 'splitInBatches':
      return clip(`batch ${str(p.batchSize) ?? '1'}`);
    case 'agent':
    case 'chainLlm':
    case 'openAi':
    case 'informationExtractor':
    case 'textClassifier':
    case 'sentimentAnalysis': {
      const prompt = str(p.text) ?? str(p.prompt) ?? str(p.messages?.values?.[0]?.content) ?? '';
      const system = str(p.options?.systemMessage);
      return clip(`${prompt}${system ? ` [system ${system.length} chars]` : ''}`);
    }
    case 'executeWorkflow':
    case 'toolWorkflow':
      return clip(`calls ${resourceLocator(p.workflowId) ?? '?'}`);
    case 'merge':
      return clip(str(p.mode) ?? 'append');
    case 'wait':
      return clip(`${str(p.resume) ?? ''} ${str(p.amount) ?? ''} ${str(p.unit) ?? ''}`.trim());
  }

  if (type.startsWith('lmChat') || type.startsWith('lm') || type.startsWith('embeddings')) {
    return clip(resourceLocator(p.model) ?? str(p.modelName) ?? '');
  }

  const resource = str(p.resource);
  const operation = str(p.operation);
  const target = resourceLocator(p.documentId) ?? resourceLocator(p.sheetName) ?? resourceLocator(p.channelId) ?? resourceLocator(p.base) ?? resourceLocator(p.table);
  if (resource || operation) {
    return clip([resource, operation].filter(Boolean).join('.') + (target ? ` ${target}` : ''));
  }

  const scalars = Object.entries(p)
    .filter(([, v]) => str(v) !== undefined && str(v) !== '')
    .slice(0, 3)
    .map(([k, v]) => `${k}=${str(v)}`);
  return clip(scalars.join(' '));
}
