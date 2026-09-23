import type { ToolRiskClass } from './types.js';

/** MCP tool annotations (hints only — untrusted, used to seed the admin's classification). */
export interface ToolAnnotations {
  readOnlyHint?: boolean | undefined;
  destructiveHint?: boolean | undefined;
  idempotentHint?: boolean | undefined;
  openWorldHint?: boolean | undefined;
}

/**
 * Suggest a risk class. Annotations are hints from an untrusted server, so the
 * suggestion errs toward caution: anything not explicitly read-only is at least
 * WRITE, and destructive (or unannotated) tools default to SENSITIVE.
 */
export function suggestRiskClass(annotations: ToolAnnotations | undefined): ToolRiskClass {
  if (!annotations) return 'SENSITIVE';
  if (annotations.readOnlyHint === true && annotations.destructiveHint !== true) return 'READ';
  if (annotations.destructiveHint === false) return 'WRITE';
  return 'SENSITIVE';
}

const MAX_TOOL_NAME = 64;

/**
 * Model-facing tool name: `<connection>__<tool>` restricted to [a-zA-Z0-9_-]
 * (the strictest common provider charset), max 64 chars, deterministic.
 */
export function modelToolName(connectionName: string, toolName: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const full = `${clean(connectionName)}__${clean(toolName)}`;
  return full.length <= MAX_TOOL_NAME ? full : full.slice(0, MAX_TOOL_NAME);
}

const MAX_DESCRIPTION = 1_024;

/** Tool descriptions from MCP servers are data: strip control chars and cap length. */
export function sanitizeToolDescription(description: string | undefined): string {
  return (description ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, MAX_DESCRIPTION);
}
