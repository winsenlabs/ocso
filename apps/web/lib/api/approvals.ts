import 'server-only';
import {
  ApprovalCountsSchema,
  ApprovalKindSchema,
  ApprovalPageSchema,
  CheckerChoiceSchema,
  ObjectApprovalStateSchema,
  ProposalDetailSchema,
} from '@/components/approvals/lib/schemas';
import { z } from 'zod';
import { api } from './client';

/**
 * Maker–checker (PM/research/11 §4; apps/api/src/modules/approvals). The API
 * scopes every read to the proposals the user may see; the UI never filters
 * for security. Payloads are never returned.
 */
const enc = encodeURIComponent;

export interface ApprovalListQuery {
  box: 'AWAITING_ME' | 'SENT_BY_ME' | 'OPEN' | 'DECIDED';
  objectKind?: string | undefined;
  needsChecker?: boolean | undefined;
  before?: string | undefined;
  beforeId?: string | undefined;
  limit?: number | undefined;
}

export function listApprovals(q: ApprovalListQuery) {
  const params = new URLSearchParams({ box: q.box, limit: String(q.limit ?? 50) });
  if (q.objectKind) params.set('objectKind', q.objectKind);
  if (q.needsChecker) params.set('needsChecker', 'true');
  if (q.before && q.beforeId) {
    params.set('before', q.before);
    params.set('beforeId', q.beforeId);
  }
  return api.get(`/v1/approvals?${params.toString()}`, ApprovalPageSchema);
}

export const approvalCounts = () => api.get('/v1/approvals/counts', ApprovalCountsSchema);
export const approvalKinds = () => api.get('/v1/approvals/kinds', z.array(ApprovalKindSchema));
export const getApproval = (id: string) => api.get(`/v1/approvals/${enc(id)}`, ProposalDetailSchema);
export const checkerChoice = (objectKind: string, objectId: string) =>
  api.get(`/v1/approvals/checkers?objectKind=${enc(objectKind)}&objectId=${enc(objectId)}`, CheckerChoiceSchema);
export const reassignCandidates = (id: string) => api.get(`/v1/approvals/${enc(id)}/checkers`, CheckerChoiceSchema.shape.checkers);
export const objectApprovalState = (objectKind: string, objectId: string) =>
  api.get(`/v1/approvals/state?objectKind=${enc(objectKind)}&objectId=${enc(objectId)}`, ObjectApprovalStateSchema);

export const decideApproval = (id: string, body: { decision: 'APPROVE' | 'REJECT'; reason?: string | undefined; contentHash: string; dependencyHash?: string | undefined }) =>
  api.post(`/v1/approvals/${enc(id)}/decision`, body, ProposalDetailSchema);
export const bulkApprove = (body: { reason: string; items: Array<{ id: string; contentHash: string }> }) =>
  api.post(
    '/v1/approvals/bulk-decision',
    { decision: 'APPROVE', ...body },
    z.object({ batchId: z.string(), approved: z.array(z.string()), skipped: z.array(z.object({ id: z.string(), code: z.string(), message: z.string() })) }),
  );
export const reassignApproval = (id: string, body: { checkerId: string; reason: string }) => api.post(`/v1/approvals/${enc(id)}/checker`, body, ProposalDetailSchema);
export const withdrawApproval = (id: string, reason: string) => api.command('POST', `/v1/approvals/${enc(id)}/withdraw`, { reason });
export const voidApproval = (id: string, reason: string) => api.post(`/v1/approvals/${enc(id)}/void`, { reason }, ProposalDetailSchema);
export const editApproval = (id: string, body: { checkerId?: string | undefined; reason?: string | undefined }) => api.patch(`/v1/approvals/${enc(id)}`, body, ProposalDetailSchema);
