import type { ApprovalOutcome } from '@ocso/application';
import type { Response } from 'express';

/**
 * How an approvable write endpoint answers (PM/research/11 §4.1): the applied
 * result exactly as before, or 202 `{ proposal }` when the write became a
 * proposal. Use with `@Res({ passthrough: true })`.
 */
export async function approvalResponse<T>(res: Response, outcome: Promise<ApprovalOutcome<T>>): Promise<T | { proposal: unknown }> {
  const result = await outcome;
  if (result.kind === 'applied') return result.value;
  res.status(202);
  return { proposal: result.proposal };
}
