import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { formatInr } from '../data/customers.js';
import { customerScopeError, type RequestContext } from '../request-context.js';
import type { MeridianStore } from '../store.js';
import { CARD_LAST4, CIF, fail, ok, TXN_ID } from './result.js';

/**
 * Write tools. Each honours the `Idempotency-Key` header: a retried call with
 * the same key replays the first result (`replayed: true`) instead of acting
 * twice. Authorization/confirmation is the MCP client's job (OCSO gates
 * sensitive actions); this system only enforces its own business rules.
 */
export function registerActionTools(server: McpServer, store: MeridianStore, ctx: RequestContext): void {
  server.registerTool(
    'statements.send_pdf',
    {
      title: 'Send statement PDF',
      description: 'Queue a password-protected card statement PDF to the customer’s registered WhatsApp number or email.',
      inputSchema: z.object({
        cif: CIF,
        cardLast4: CARD_LAST4,
        month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).describe('Statement month, YYYY-MM'),
        channel: z.enum(['WHATSAPP', 'EMAIL']),
      }),
      outputSchema: z.object({
        deliveryId: z.string(),
        status: z.literal('QUEUED'),
        channel: z.enum(['WHATSAPP', 'EMAIL']),
        destinationMasked: z.string(),
        month: z.string(),
        cardLast4: z.string(),
        replayed: z.boolean(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const scope = customerScopeError(ctx, input.cif);
      if (scope) return fail(scope);
      const r = store.sendStatement(input, ctx.idempotencyKey);
      if (!r.ok) return fail(r.error);
      const { deliveryId, status, channel, destinationMasked, month, cardLast4 } = r.value;
      return ok({ deliveryId, status, channel, destinationMasked, month, cardLast4, replayed: r.replayed });
    },
  );

  server.registerTool(
    'disputes.raise_case',
    {
      title: 'Raise a dispute case',
      description: 'Open a chargeback/dispute case against a card transaction (policy DSP-310).',
      inputSchema: z.object({
        cif: CIF,
        txnId: TXN_ID,
        reason: z.enum(['DUPLICATE', 'NOT_RECEIVED', 'FRAUD', 'INCORRECT_AMOUNT', 'OTHER']),
        description: z.string().min(3).max(1000),
      }),
      outputSchema: z.object({
        caseId: z.string(),
        status: z.literal('OPEN'),
        txnId: z.string(),
        reason: z.string(),
        slaDueDate: z.string(),
        replayed: z.boolean(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      const scope = customerScopeError(ctx, input.cif);
      if (scope) return fail(scope);
      const r = store.raiseDispute(input, ctx.idempotencyKey);
      if (!r.ok) return fail(r.error);
      const { caseId, status, txnId, reason, slaDueDate } = r.value;
      return ok({ caseId, status, txnId, reason, slaDueDate, replayed: r.replayed });
    },
  );

  server.registerTool(
    'payments.reverse_transaction',
    {
      title: 'Reverse a settled debit',
      description:
        'Reverse (credit back) all or part of a settled card debit, e.g. a duplicate EMI authorisation. Moves money and cannot be undone once the credit settles.',
      inputSchema: z.object({
        cif: CIF,
        txnId: TXN_ID,
        amountMinor: z.number().int().positive().describe('Amount to reverse in paise'),
        reason: z.string().min(3).max(500),
      }),
      outputSchema: z.object({
        reference: z.string(),
        status: z.literal('ACCEPTED'),
        txnId: z.string(),
        amountMinor: z.number().int(),
        amount: z.string(),
        expectedCreditBy: z.string(),
        replayed: z.boolean(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      const scope = customerScopeError(ctx, input.cif);
      if (scope) return fail(scope);
      const r = store.reverseTransaction(input, ctx.idempotencyKey);
      if (!r.ok) return fail(r.error);
      const { reference, status, txnId, amountMinor, expectedCreditBy } = r.value;
      return ok({ reference, status, txnId, amountMinor, amount: formatInr(amountMinor), expectedCreditBy, replayed: r.replayed });
    },
  );
}
