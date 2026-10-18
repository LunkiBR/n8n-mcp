/**
 * Serialization of JSON tool results.
 *
 * Results are sent without indentation: the content is identical to the pretty-printed form, and an
 * agent reading it pays fewer tokens for whitespace. N8N_MCP_COMPACT_JSON=false restores indentation.
 */
export function formatToolJson(value: unknown): string {
  return process.env.N8N_MCP_COMPACT_JSON === 'false' ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}
