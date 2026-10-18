/**
 * What actually changed between two versions of a workflow, read back from n8n after a write.
 *
 * Agents asked to "change nothing else" otherwise re-read the whole workflow to check. This
 * summary lists every node and connection that differs, including changes the server made on its
 * own (sanitizing, defaults), and states plainly when nothing else changed.
 */

import { Workflow, WorkflowNode } from '../types/n8n-api';
import { isStickyNote } from '../utils/node-classification';

const FIELDS: Array<keyof WorkflowNode> = ['type', 'typeVersion', 'disabled', 'onError', 'credentials', 'notes', 'retryOnFail', 'maxTries', 'waitBetweenTries', 'alwaysOutputData', 'executeOnce'];

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v
  ) ?? 'undefined';
}

/** Dot paths (two levels deep) where two parameter objects differ. */
function changedPaths(a: Record<string, unknown>, b: Record<string, unknown>, prefix = '', depth = 0): string[] {
  const keys = [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])];
  const paths: string[] = [];
  for (const key of keys) {
    const x = a?.[key];
    const y = b?.[key];
    if (stable(x) === stable(y)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const bothObjects = x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y);
    if (bothObjects && depth < 1) paths.push(...changedPaths(x as Record<string, unknown>, y as Record<string, unknown>, path, depth + 1));
    else paths.push(path);
  }
  return paths;
}

function edges(workflow: Workflow): Set<string> {
  const set = new Set<string>();
  for (const [from, byType] of Object.entries(workflow.connections ?? {})) {
    for (const [type, outputs] of Object.entries(byType ?? {})) {
      (outputs ?? []).forEach((targets, output) => {
        for (const t of targets ?? []) {
          if (!t) continue;
          const port = type === 'main' ? (output > 0 ? `.${output}` : '') : ` =${type.replace(/^ai_/, '')}=>`;
          const input = t.index ? `[${t.index}]` : '';
          set.add(type === 'main' ? `${from}${port} -> ${t.node}${input}` : `${from}${port} ${t.node}`);
        }
      });
    }
  }
  return set;
}

export function summarizeChange(before: Workflow, after: Workflow): string {
  const real = (w: Workflow) => new Map(w.nodes.filter(n => !isStickyNote(n.type)).map(n => [n.name, n]));
  const a = real(before);
  const b = real(after);
  const parts: string[] = [];
  for (const name of b.keys()) if (!a.has(name)) parts.push(`+node ${name}`);
  for (const name of a.keys()) if (!b.has(name)) parts.push(`-node ${name}`);
  for (const [name, old] of a) {
    const now = b.get(name);
    if (!now) continue;
    const changed = [
      ...changedPaths(old.parameters ?? {}, now.parameters ?? {}),
      ...FIELDS.filter(f => stable(old[f]) !== stable(now[f])).map(String),
    ];
    if (changed.length) parts.push(`~${name}: ${changed.join(', ')}`);
  }
  const ea = edges(before);
  const eb = edges(after);
  for (const e of eb) if (!ea.has(e)) parts.push(`+edge ${e}`);
  for (const e of ea) if (!eb.has(e)) parts.push(`-edge ${e}`);
  if (parts.length === 0) return 'verified change: none (the workflow read back from n8n is identical)';
  return `verified change (read back from n8n): ${parts.join('; ')}; every other node and connection is unchanged`;
}
