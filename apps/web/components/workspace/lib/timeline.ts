import type { ToolRisk } from '../../ui/risk-badge';
import { formatLatency } from '../../../lib/format';

const RISK_BADGE: Readonly<Record<string, ToolRisk>> = { READ: 'read', WRITE: 'write', SENSITIVE: '2-step' };

/** API risk class → design risk badge (unknown classes are treated as writes). */
export const riskOf = (riskClass: string): ToolRisk => RISK_BADGE[riskClass] ?? 'write';

/**
 * Presentation rules for timeline tool events (design/01 .toolev): the mono
 * meta line and `key value` facts. Only what the API returned — sanitized
 * arguments and result summaries — never chain-of-thought.
 */

export type ToolDot = 'ok' | 'warn' | 'fail';

export function toolDot(status: string): ToolDot {
  if (status === 'SUCCEEDED') return 'ok';
  if (status === 'FAILED' || status === 'DENIED' || status === 'EXPIRED') return 'fail';
  return 'warn';
}

const RISK_WORDS: Readonly<Record<string, string>> = { READ: 'read-only', WRITE: 'write', SENSITIVE: 'sensitive write' };

const STATUS_WORDS: Readonly<Record<string, string>> = {
  REQUESTED: 'requested',
  RUNNING: 'running',
  SUCCEEDED: 'ok',
  FAILED: 'failed',
  DENIED: 'denied',
  EXPIRED: 'confirmation expired',
  AWAITING_CONFIRMATION: 'awaiting confirmation',
};

export interface ToolMetaInput {
  connectionName: string | null;
  riskClass: string | null;
  status: string;
  actorType: string;
  latencyMs: number | null;
  confirmedByName: string | null;
  decisionReason: string | null;
  errorCategory: string | null;
}

/** "meridian-crm · read-only · 412ms · ok" / "… · sensitive write · confirmed by Nikhil Menon · 1.8s · ok". */
export function toolMeta(t: ToolMetaInput): string {
  const parts: string[] = [];
  if (t.connectionName) parts.push(t.connectionName);
  if (t.riskClass) parts.push(RISK_WORDS[t.riskClass] ?? t.riskClass.toLowerCase());
  if (t.actorType === 'HUMAN') parts.push('run by a human');
  if (t.confirmedByName && t.status !== 'DENIED') parts.push(`confirmed by ${t.confirmedByName}`);
  if (t.status === 'DENIED' && t.confirmedByName) parts.push(`denied by ${t.confirmedByName}`);
  if (t.latencyMs !== null) parts.push(formatLatency(t.latencyMs));
  parts.push(STATUS_WORDS[t.status] ?? t.status.toLowerCase());
  if (t.status === 'FAILED' && t.errorCategory) parts.push(t.errorCategory.replace(/_/g, ' '));
  return parts.join(' · ');
}

export interface Fact {
  k: string;
  v: string;
}

/** Top-level scalars of an object as facts; arrays become counts; nested objects are skipped. */
export function factsOf(value: unknown, limit = 6): Fact[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const facts: Fact[] = [];
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (facts.length >= limit) break;
    const k = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) facts.push({ k, v: `${v.length} item${v.length === 1 ? '' : 's'}` });
    else if (typeof v === 'object') continue;
    else facts.push({ k, v: truncate(String(v), 80) });
  }
  return facts;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Bytes as the design writes them: "184 KB", "2.4 MB". */
export function formatBytes(bytes: number | undefined): string | null {
  if (bytes === undefined || !Number.isFinite(bytes)) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Three-letter mono label for an attachment thumb: "JPG", "PDF". */
export function fileBadge(mimeType: string, filename?: string): string {
  const ext = filename?.includes('.') ? filename.split('.').pop() : mimeType.split('/').pop();
  return (ext ?? 'FILE').replace(/[^a-z0-9]/gi, '').slice(0, 4).toUpperCase() || 'FILE';
}
