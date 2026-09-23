import type { StatusTone } from '../../ui/status-chip';
import type { ToolRisk } from '../../ui/risk-badge';
import type { AuthRequired, Connection, RiskClass } from '../../../lib/api/mcp';

/** Presentation of MCP connections (design/04). Pure and client-safe. */

export const WIZARD_STEPS = [
  { key: 'url', label: 'Enter URL' },
  { key: 'discover', label: 'Discover server' },
  { key: 'auth', label: 'Authenticate' },
  { key: 'review', label: 'Review capabilities' },
  { key: 'approve', label: 'Approve' },
  { key: 'active', label: 'Active' },
] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number]['key'];

export const STEP_NOTES: Readonly<Record<WizardStep, string>> = {
  url: 'OCSO saves a draft and checks the URL against the egress policy',
  discover: 'read-only inspection of the server',
  auth: 'tokens go to the secret store, never to the model',
  review: 'unapproved tools are never exposed',
  approve: 'sensitive tools keep a human in the loop',
  active: 'health checks running',
};

export function stepIndex(step: WizardStep): number {
  return WIZARD_STEPS.findIndex((s) => s.key === step);
}

/** Where a saved connection resumes in the wizard. */
export function stepForStage(stage: Connection['stage']): WizardStep {
  switch (stage) {
    case 'DISCOVER':
      return 'discover';
    case 'AUTHENTICATE':
      return 'auth';
    case 'REVIEW':
      return 'review';
    default:
      return 'active';
  }
}

export function parseStep(value: string | undefined): WizardStep | null {
  return WIZARD_STEPS.find((s) => s.key === value)?.key ?? null;
}

export function connectionStatus(c: Pick<Connection, 'status' | 'stage' | 'health'>): { tone: StatusTone; label: string } {
  switch (c.status) {
    case 'ACTIVE':
      return c.health.status === 'HEALTHY' ? { tone: 'good', label: 'healthy' } : { tone: 'good', label: 'active' };
    case 'DEGRADED':
      return { tone: 'warn', label: 'degraded' };
    case 'DOWN':
      return { tone: 'danger', label: 'down' };
    case 'AUTH_REQUIRED':
      return { tone: 'warn', label: 'auth required' };
    case 'DISABLED':
      return { tone: 'muted', label: 'disabled' };
    default:
      return { tone: 'accent', label: `draft · ${c.stage.toLowerCase()}` };
  }
}

/** Approved connections that need attention (the design's degraded banner). */
export function needsAttention(c: Pick<Connection, 'status' | 'approvedAt' | 'tools'>): boolean {
  if (!c.approvedAt || c.status === 'DISABLED') return false;
  return c.status === 'DEGRADED' || c.status === 'DOWN' || c.status === 'AUTH_REQUIRED' || c.tools.changed > 0;
}

export function authLabel(auth: Connection['auth']): string {
  if (auth.strategy === 'OAUTH') return 'OAuth 2.1';
  if (auth.strategy === 'HEADER') return `header · ${auth.headerName ?? 'token'}`;
  return 'none';
}

export function scopeLabel(kind: Connection['kind']): string {
  return kind === 'TEMPLATE' ? 'user-scoped' : kind === 'PERSONAL' ? 'personal' : 'shared';
}

export const RISK_BADGE: Readonly<Record<RiskClass, ToolRisk>> = { READ: 'read', WRITE: 'write', SENSITIVE: '2-step' };
export const RISK_LABEL: Readonly<Record<RiskClass, string>> = { READ: 'Read only', WRITE: 'Reversible write', SENSITIVE: 'Sensitive / irreversible' };

export const CONFIRMATION_LABEL = {
  SENSITIVE_ONLY: 'Human confirmation for sensitive tools',
  ALL_WRITES: 'Always confirm writes',
  NONE: 'No confirmation (not recommended)',
} as const;

const OAUTH_REASONS: Readonly<Record<string, string>> = {
  state_mismatch: 'The authorization response did not match a pending request (expired, reused or forged). Start the authorization again.',
  pending_expired: 'The authorization took too long and expired. Start it again.',
  authorization_denied: 'The authorization server denied access.',
  missing_code: 'The authorization server returned no authorization code.',
  token_exchange_failed: 'Exchanging the authorization code for tokens failed.',
  issuer_mismatch: 'The response came from an unexpected authorization server (issuer mismatch).',
  pkce_unsupported: 'The authorization server does not support PKCE S256, which OCSO requires.',
  registration_unavailable: 'The authorization server offers no client registration; enter a pre-registered client ID.',
  registration_rejected: 'The authorization server rejected client registration.',
  insecure_endpoint: 'The authorization server uses an insecure endpoint.',
  invalid_request: 'The callback request was malformed.',
  mcp_connection_disabled: 'The connection was disabled while authorizing.',
  forbidden: 'The user who started the authorization can no longer manage this connection.',
};

/** Callback `reason` (a stable code, never server text) → sentence for the banner. */
export function oauthReasonText(reason: string | undefined): string {
  if (!reason) return 'The authorization did not complete.';
  return OAUTH_REASONS[reason] ?? `The authorization did not complete (${reason.replace(/_/g, ' ')}).`;
}

export interface ServerInfoSummary {
  name: string | null;
  version: string | null;
  protocolEra: string | null;
  latencyMs: number | null;
  capabilities: string[];
  instructions: string | null;
  authRequired: AuthRequired | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);

function authRequiredOf(v: unknown): AuthRequired | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return {
    reason: str(o['reason']) ?? 'unauthorized',
    resourceMetadataUrl: str(o['resourceMetadataUrl']),
    resource: str(o['resource']),
    authorizationServers: strings(o['authorizationServers']),
    scopesSupported: strings(o['scopesSupported']),
    challengedScope: str(o['challengedScope']),
    oauthAvailable: o['oauthAvailable'] === true,
  };
}

/** serverInfo is server-provided (untrusted): keep only typed scalars for plain-text rendering. */
export function serverInfoSummary(info: Record<string, unknown>): ServerInfoSummary {
  const caps = info['capabilities'];
  return {
    name: str(info['name']),
    version: str(info['version']),
    protocolEra: str(info['protocolEra']),
    latencyMs: typeof info['latencyMs'] === 'number' ? info['latencyMs'] : null,
    capabilities: caps && typeof caps === 'object' ? Object.keys(caps).filter((k) => /^[a-zA-Z]{1,40}$/.test(k)) : [],
    instructions: str(info['instructions'])?.slice(0, 600) ?? null,
    authRequired: authRequiredOf(info['authRequired']),
  };
}
