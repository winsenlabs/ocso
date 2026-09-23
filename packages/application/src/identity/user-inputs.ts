import { ROLES } from '@ocso/auth';
import { z } from 'zod';
import { ApprovalChoice } from './permissions/change-set.js';

export const CreateUserInput = z.object({
  email: z.email().max(320),
  name: z.string().trim().min(1).max(200),
  role: z.enum(ROLES),
  /** Admin-set initial password: only when invites cannot be emailed (EMAIL_DRIVER=log). */
  password: z.string().min(12).max(256).optional(),
  teamIds: z.array(z.uuid()).default([]),
  languages: z.array(z.string().max(20)).max(20).default([]),
  skills: z.array(z.string().max(60)).max(50).default([]),
  maxConcurrent: z.number().int().min(1).max(50).default(8),
  /** Submit the new user for approval at once (PM/research/11 §3.5). */
  approval: ApprovalChoice.optional(),
});
export type CreateUserInput = z.input<typeof CreateUserInput>;

export const UpdateUserInput = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  role: z.enum(ROLES).optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  teamIds: z.array(z.uuid()).max(200).optional(),
  languages: z.array(z.string().max(20)).max(20).optional(),
  skills: z.array(z.string().max(60)).max(50).optional(),
  maxConcurrent: z.number().int().min(1).max(50).optional(),
  /** Why access changed (audit and the approval); a default is used when omitted. */
  reason: z.string().trim().min(3).max(500).optional(),
  approval: ApprovalChoice.optional(),
});
export type UpdateUserInput = z.input<typeof UpdateUserInput>;
