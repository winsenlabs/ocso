import type { Tool } from '@modelcontextprotocol/client';
import { modelToolName, sanitizeToolDescription, suggestRiskClass, type ToolAnnotations, type ToolRiskClass } from '@ocso/tools';
import { canonicalJson, sha256Hex } from '../canonical-json.js';

/** A server tool as OCSO presents it for admin review. Everything server-provided is treated as data. */
export interface DiscoveredTool {
  /** The tool's name on its server (used for `tools/call`). */
  name: string;
  title?: string | undefined;
  /** Sanitized (control chars stripped, length capped); still untrusted text. */
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown> | undefined;
  /** Hints only (untrusted); used to seed `suggestedRisk`. */
  annotations?: ToolAnnotations | undefined;
  suggestedRisk: ToolRiskClass;
  /** Provider-safe, connection-prefixed, unique within the connection. */
  modelName: string;
  /** sha256 of canonical JSON of `{ name, inputSchema }` — changes invalidate cached tool schemas. */
  schemaHash: string;
  /** sha256 over the full raw definition (name, title, description, schemas, annotations) — drift ⇒ re-approval. */
  definitionHash: string;
}

export interface NormalizeOptions {
  maxTools: number;
  /** Max canonical-JSON size of one tool's schemas. */
  maxSchemaBytes: number;
}

const MAX_TITLE = 200;
const MAX_NAME = 128;
const HINT_KEYS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

function pickAnnotations(raw: Tool['annotations']): ToolAnnotations | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: ToolAnnotations = {};
  for (const key of HINT_KEYS) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === 'boolean') out[key] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function uniqueModelNames(connectionName: string, names: string[]): Map<string, string> {
  const base = new Map(names.map((n) => [n, modelToolName(connectionName, n)]));
  const counts = new Map<string, number>();
  for (const m of base.values()) counts.set(m, (counts.get(m) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const [name, m] of base) {
    // Every member of a collision set gets a stable, order-independent suffix.
    out.set(name, (counts.get(m) ?? 0) > 1 ? `${m.slice(0, 57)}_${sha256Hex(name).slice(0, 6)}` : m);
  }
  return out;
}

export function normalizeTools(
  connectionName: string,
  tools: readonly Tool[],
  options: NormalizeOptions,
): { tools: DiscoveredTool[]; warnings: string[] } {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const accepted: Tool[] = [];
  for (const tool of [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const name = tool.name;
    if (typeof name !== 'string' || !name || name.length > MAX_NAME || /[\u0000-\u001F\u007F]/.test(name)) {
      warnings.push('skipped a tool with an invalid name');
      continue;
    }
    if (seen.has(name)) {
      warnings.push(`skipped duplicate tool "${name}"`);
      continue;
    }
    const size = canonicalJson({ i: tool.inputSchema, o: tool.outputSchema }).length;
    if (size > options.maxSchemaBytes) {
      warnings.push(`skipped tool "${name}": schema larger than ${options.maxSchemaBytes} bytes`);
      continue;
    }
    if (accepted.length >= options.maxTools) {
      warnings.push(`tool list truncated at ${options.maxTools} tools`);
      break;
    }
    seen.add(name);
    accepted.push(tool);
  }

  const modelNames = uniqueModelNames(connectionName, accepted.map((t) => t.name));
  const normalized = accepted.map((tool): DiscoveredTool => {
    const annotations = pickAnnotations(tool.annotations);
    const title = tool.title ?? tool.annotations?.title;
    const inputSchema = tool.inputSchema as Record<string, unknown>;
    const outputSchema = tool.outputSchema as Record<string, unknown> | undefined;
    return {
      name: tool.name,
      ...(title ? { title: sanitizeToolDescription(title).slice(0, MAX_TITLE) } : {}),
      description: sanitizeToolDescription(tool.description),
      inputSchema,
      ...(outputSchema ? { outputSchema } : {}),
      ...(annotations ? { annotations } : {}),
      suggestedRisk: suggestRiskClass(annotations),
      modelName: modelNames.get(tool.name) as string,
      schemaHash: sha256Hex(canonicalJson({ name: tool.name, inputSchema })),
      definitionHash: sha256Hex(
        canonicalJson({
          name: tool.name,
          title: tool.title ?? null,
          description: tool.description ?? null,
          inputSchema,
          outputSchema: outputSchema ?? null,
          annotations: tool.annotations ?? null,
        }),
      ),
    };
  });
  return { tools: normalized, warnings };
}

/** Order-independent hash of a connection's whole tool set (drift detection / cache keys). */
export function toolSetHash(tools: readonly DiscoveredTool[]): string {
  return sha256Hex(canonicalJson(tools.map((t) => [t.name, t.definitionHash]).sort()));
}
