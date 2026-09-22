import { validation, type ToolSpec } from '@ocso/domain';
import { jsonSchema, tool, type JSONSchema7, type ToolSet } from 'ai';

/**
 * Schema-only tool definitions (ADR-014): no `execute`, so the SDK loop stops
 * at `finishReason: 'tool-calls'` and OCSO authorizes + executes the call.
 * Keys are inserted in name order; the call also passes `toolOrder: []` so
 * the SDK sorts regardless (stable prefix for provider caching).
 */
export function toSdkTools(tools: readonly ToolSpec[]): ToolSet | undefined {
  if (tools.length === 0) return undefined;
  const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const set: ToolSet = {};
  for (const spec of sorted) {
    if (Object.hasOwn(set, spec.name)) {
      throw validation('tool_name_duplicate', `Tool name ${spec.name} is defined twice`);
    }
    set[spec.name] = tool({
      description: spec.description,
      // ToolSpec.inputSchema is JSON Schema (draft 2020-12 subset) from admin-approved records.
      inputSchema: jsonSchema<unknown>(spec.inputSchema as JSONSchema7),
    });
  }
  return set;
}
