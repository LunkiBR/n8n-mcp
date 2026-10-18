/**
 * Output field schemas per node, read from an execution's run data or a workflow's pinData.
 *
 * The zoom view shows which fields the nodes it reads from actually produce. Values are never
 * shown, only paths and types, so the output stays small and does not leak data.
 */

export type FieldSchema = Map<string, string>;

export interface NodeOutput {
  fields: FieldSchema;
  items: number;
  /** Where the schema came from. */
  source: 'execution' | 'pinData';
  error?: string;
}

const MAX_DEPTH = 2;
const MAX_ITEMS = 3;
const MAX_FIELDS = 40;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    const inner = value.length > 0 ? typeOf(value[0]) : 'unknown';
    return `${inner}[]`;
  }
  return typeof value;
}

function collect(value: unknown, prefix: string, depth: number, out: FieldSchema) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (out.size >= MAX_FIELDS) return;
    const path = prefix ? `${prefix}.${key}` : key;
    const type = typeOf(child);
    if (!out.has(path) || out.get(path) === 'null') out.set(path, type);
    if (depth < MAX_DEPTH && type === 'object') collect(child, path, depth + 1, out);
  }
}

export function schemaOfItems(items: Array<{ json?: unknown }>): FieldSchema {
  const fields: FieldSchema = new Map();
  for (const item of items.slice(0, MAX_ITEMS)) collect(item?.json, '', 1, fields);
  return fields;
}

/**
 * Per-node outputs from an n8n execution object (`data.resultData.runData`). Only the last run of
 * each node and its first output are read; that is what downstream `$json` sees in the common case.
 */
export function outputsFromExecution(execution: unknown): Map<string, NodeOutput> {
  const result = new Map<string, NodeOutput>();
  const runData = (execution as any)?.data?.resultData?.runData;
  if (!runData || typeof runData !== 'object') return result;
  for (const [node, runs] of Object.entries(runData as Record<string, any[]>)) {
    if (!Array.isArray(runs) || runs.length === 0) continue;
    const run = runs[runs.length - 1];
    const outputs: any[] = run?.data?.main ?? [];
    const items: any[] = outputs.find((o: any) => Array.isArray(o) && o.length > 0) ?? [];
    const error = run?.error ? String(run.error.message ?? run.error.description ?? 'error') : undefined;
    result.set(node, { fields: schemaOfItems(items), items: items.length, source: 'execution', ...(error ? { error } : {}) });
  }
  return result;
}

export function outputsFromPinData(pinData: unknown): Map<string, NodeOutput> {
  const result = new Map<string, NodeOutput>();
  if (!pinData || typeof pinData !== 'object') return result;
  for (const [node, items] of Object.entries(pinData as Record<string, any[]>)) {
    if (!Array.isArray(items)) continue;
    const normalized = items.map(i => (i && typeof i === 'object' && 'json' in i ? i : { json: i }));
    result.set(node, { fields: schemaOfItems(normalized), items: items.length, source: 'pinData' });
  }
  return result;
}

export function formatFields(fields: FieldSchema, limit = 12): string {
  const top = [...fields.entries()].filter(([path]) => !path.includes('.') || fields.size <= limit);
  const shown = top.slice(0, limit).map(([path, type]) => `${path}:${type}`);
  const more = fields.size > shown.length ? ` +${fields.size - shown.length}` : '';
  return shown.join(', ') + more;
}
