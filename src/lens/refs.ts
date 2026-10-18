/**
 * Data references made by a node's expressions and code.
 *
 * An n8n node reads data in two ways: implicitly from its main input (`$json`, `$input`, `item`
 * in code) or explicitly from any earlier node by name (`$('Name')`, legacy `$node["Name"]`,
 * `$items("Name")`). The lens uses these references to make sure a zoom never hides the nodes
 * a zoomed node depends on.
 */

import { WorkflowNode } from '../types/n8n-api';

export interface ExprRef {
  /** Node read by name. Undefined for implicit reads from the main input. */
  node?: string;
  /** Field path read from the item's JSON, e.g. `customer.tier`. Undefined when the whole item is read. */
  field?: string;
  /** Parameter path where the read happens, e.g. `url` or `assignments.assignments[0].value`. */
  at: string;
}

/** Parameter keys whose whole string value is source code rather than an `=`-prefixed expression. */
const CODE_KEYS = new Set(['jsCode', 'pythonCode', 'functionCode', 'code']);

const STR = String.raw`(['"\x60])((?:\\.|(?!\1)[^\\])*)\1`;
const FIELD_CHAIN = String.raw`((?:\s*\.\s*[A-Za-z_$][\w$]*|\s*\[\s*(?:'[^']*'|"[^"]*"|\d+)\s*\])*)`;
const ITEM_ACCESSOR = String.raw`(?:item|first\(\s*\)|last\(\s*\)|all\(\s*\)\s*\[\s*\d+\s*\]|itemMatching\([^)]*\))`;

const NODE_CALL = new RegExp(String.raw`\$\(\s*${STR}\s*\)`, 'g');
const AFTER_NODE_CALL = new RegExp(String.raw`^\s*\.\s*${ITEM_ACCESSOR}\s*\.\s*json${FIELD_CHAIN}`);
const LEGACY_NODE = new RegExp(String.raw`\$node\s*\[\s*${STR}\s*\]\s*\.\s*json${FIELD_CHAIN}`, 'g');
const LEGACY_NODE_DOT = new RegExp(String.raw`\$node\s*\.\s*([A-Za-z_$][\w$]*)\s*\.\s*json${FIELD_CHAIN}`, 'g');
const ITEMS_CALL = new RegExp(String.raw`\$items\(\s*${STR}`, 'g');
const IMPLICIT_JSON = new RegExp(String.raw`\$json${FIELD_CHAIN}`, 'g');
const IMPLICIT_INPUT = new RegExp(String.raw`\$input\s*\.\s*${ITEM_ACCESSOR}\s*\.\s*json${FIELD_CHAIN}`, 'g');
const IMPLICIT_INPUT_WHOLE = /\$input\s*\.\s*(?:all|first|last)\s*\(|\$input\s*\.\s*item\b/g;
/** Code receivers that hold the node's input items. */
const INPUT_ITEMS = String.raw`(?:\$input\s*\.\s*all\s*\(\s*\)|(?<![\w$.])items)`;
/** Callback and loop variables bound to input items: `$input.all().map(i => ...)`, `for (const row of items)`. */
const ITEM_BINDINGS = [
  new RegExp(String.raw`${INPUT_ITEMS}\s*\.\s*(?:map|forEach|filter|flatMap|some|every|find|findIndex)\(\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)`, 'g'),
  new RegExp(String.raw`for\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+${INPUT_ITEMS}`, 'g'),
];

/** `<item>.json.field` reads in code, where item is `item`, `items[n]` or a variable bound to input items. */
function codeItemJson(code: string): RegExp {
  const names = new Set(['item']);
  for (const binding of ITEM_BINDINGS) {
    binding.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = binding.exec(code)) !== null) names.add(match[1]);
  }
  const alternatives = [...names].map(n => n.replace(/\$/g, '\\$')).join('|');
  return new RegExp(String.raw`(?<![\w$.])(?:${alternatives}|items\s*\[\s*\w+\s*\])\s*\.\s*json${FIELD_CHAIN}`, 'g');
}

/** Turns `.a["b c"][0].d` into `a.b c[0].d`. */
export function normalizeFieldChain(chain: string | undefined): string | undefined {
  if (!chain) return undefined;
  const parts: string[] = [];
  const segment = /\.\s*([A-Za-z_$][\w$]*)|\[\s*(?:'([^']*)'|"([^"]*)"|(\d+))\s*\]/g;
  let match: RegExpExecArray | null;
  while ((match = segment.exec(chain)) !== null) {
    if (match[4] !== undefined) {
      if (parts.length === 0) break;
      parts[parts.length - 1] += `[${match[4]}]`;
    } else {
      parts.push(match[1] ?? match[2] ?? match[3] ?? '');
    }
  }
  return parts.length > 0 ? parts.join('.') : undefined;
}

function unescapeName(raw: string): string {
  return raw.replace(/\\(.)/g, '$1');
}

/** References in one string. `isCode` scans plain code; otherwise only `=`-prefixed expressions count. */
export function extractRefsFromString(value: string, at: string, isCode: boolean): ExprRef[] {
  if (!isCode && !value.startsWith('=')) return [];
  const refs: ExprRef[] = [];

  NODE_CALL.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NODE_CALL.exec(value)) !== null) {
    const rest = value.slice(match.index + match[0].length, match.index + match[0].length + 400);
    const accessor = AFTER_NODE_CALL.exec(rest);
    refs.push({ node: unescapeName(match[2]), field: normalizeFieldChain(accessor?.[1]), at });
  }

  LEGACY_NODE.lastIndex = 0;
  while ((match = LEGACY_NODE.exec(value)) !== null) {
    refs.push({ node: unescapeName(match[2]), field: normalizeFieldChain(match[3]), at });
  }
  LEGACY_NODE_DOT.lastIndex = 0;
  while ((match = LEGACY_NODE_DOT.exec(value)) !== null) {
    refs.push({ node: match[1], field: normalizeFieldChain(match[2]), at });
  }
  ITEMS_CALL.lastIndex = 0;
  while ((match = ITEMS_CALL.exec(value)) !== null) {
    refs.push({ node: unescapeName(match[2]), at });
  }

  const implicit: RegExp[] = [IMPLICIT_JSON, IMPLICIT_INPUT];
  if (isCode) implicit.push(codeItemJson(value));
  let sawImplicitField = false;
  for (const regex of implicit) {
    regex.lastIndex = 0;
    while ((match = regex.exec(value)) !== null) {
      sawImplicitField = true;
      refs.push({ field: normalizeFieldChain(match[1]), at });
    }
  }
  if (!sawImplicitField) {
    IMPLICIT_INPUT_WHOLE.lastIndex = 0;
    if (IMPLICIT_INPUT_WHOLE.test(value)) refs.push({ at });
  }
  return refs;
}

/** Every reference made by a node's parameters, deduplicated by (node, field). */
export function extractNodeRefs(node: WorkflowNode): ExprRef[] {
  const found: ExprRef[] = [];
  const walk = (value: unknown, path: string, key: string) => {
    if (typeof value === 'string') {
      found.push(...extractRefsFromString(value, path, CODE_KEYS.has(key)));
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`, key));
    } else if (value && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) {
        walk(child, path ? `${path}.${childKey}` : childKey, childKey);
      }
    }
  };
  walk(node.parameters ?? {}, '', '');

  const seen = new Set<string>();
  return found.filter(ref => {
    const key = `${ref.node ?? ''}\u0000${ref.field ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
