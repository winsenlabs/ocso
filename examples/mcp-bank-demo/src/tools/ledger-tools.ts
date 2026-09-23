import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { findCustomer, formatInr } from '../data/customers.js';
import { searchPolicies } from '../data/policies.js';
import { TRANSACTIONS, type Transaction } from '../data/transactions.js';
import { customerScopeError, type RequestContext } from '../request-context.js';
import type { MeridianStore } from '../store.js';
import { CARD_LAST4, CIF, fail, ISO_DATE, ok, READ_ONLY } from './result.js';

const TxnOut = z.object({
  txnId: z.string(),
  postedAt: z.string(),
  valueDate: z.string(),
  description: z.string(),
  merchant: z.string(),
  category: z.string(),
  type: z.enum(['DEBIT', 'CREDIT']),
  amountMinor: z.number().int(),
  amount: z.string(),
  status: z.enum(['SETTLED', 'PENDING', 'REVERSED']),
  emiPlanId: z.string().nullable(),
  emiInstalment: z.number().int().nullable(),
  reversalReference: z.string().nullable(),
});

const DuplicateOut = z.object({
  txnIds: z.array(z.string()),
  amountMinor: z.number().int(),
  amount: z.string(),
  merchant: z.string(),
  valueDate: z.string(),
  reason: z.string(),
});

/** Settled debits sharing amount, merchant and value date are duplicate candidates (policy CRD-101). */
function duplicateCandidates(rows: readonly Transaction[]): z.infer<typeof DuplicateOut>[] {
  const groups = new Map<string, Transaction[]>();
  for (const t of rows) {
    if (t.type !== 'DEBIT' || t.status !== 'SETTLED') continue;
    const key = `${t.amountMinor}|${t.merchant}|${t.valueDate}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => {
      const first = g[0] as Transaction;
      return {
        txnIds: g.map((t) => t.txnId),
        amountMinor: first.amountMinor,
        amount: formatInr(first.amountMinor),
        merchant: first.merchant,
        valueDate: first.valueDate,
        reason: 'Same amount, merchant and value date',
      };
    });
}

export function registerLedgerTools(server: McpServer, store: MeridianStore, ctx: RequestContext): void {
  server.registerTool(
    'cards.list_transactions',
    {
      title: 'List card transactions',
      description:
        'Read the card ledger for a customer within a date window (default: 1st of the month to today). Flags duplicate debit candidates.',
      inputSchema: z.object({
        cif: CIF,
        cardLast4: CARD_LAST4.optional(),
        from: ISO_DATE.optional(),
        to: ISO_DATE.optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      outputSchema: z.object({
        cif: z.string(),
        cardLast4: z.string(),
        window: z.object({ from: z.string(), to: z.string() }),
        count: z.number().int(),
        returned: z.number().int(),
        transactions: z.array(TxnOut),
        duplicateCandidates: z.array(DuplicateOut),
      }),
      annotations: READ_ONLY,
    },
    async ({ cif, cardLast4, from, to, limit }) => {
      const scope = customerScopeError(ctx, cif);
      if (scope) return fail(scope);
      const customer = findCustomer(cif);
      if (!customer) return fail(`No customer with CIF ${cif}.`);
      const card = cardLast4 ? customer.cards.find((c) => c.last4 === cardLast4) : customer.cards[0];
      if (!card) return fail(`No card ending ${cardLast4 ?? ''} for customer ${cif}.`);
      const window = { from: from ?? `${store.businessDate.slice(0, 7)}-01`, to: to ?? store.businessDate };
      const rows = TRANSACTIONS.filter(
        (t) => t.cif === cif && t.cardLast4 === card.last4 && t.valueDate >= window.from && t.valueDate <= window.to,
      );
      const page = rows.slice(0, limit ?? 50);
      return ok({
        cif,
        cardLast4: card.last4,
        window,
        count: rows.length,
        returned: page.length,
        transactions: page.map((t) => {
          const reversal = store.reversals.get(t.txnId);
          return {
            txnId: t.txnId,
            postedAt: t.postedAt,
            valueDate: t.valueDate,
            description: t.description,
            merchant: t.merchant,
            category: t.category,
            type: t.type,
            amountMinor: t.amountMinor,
            amount: formatInr(t.amountMinor),
            status: reversal ? ('REVERSED' as const) : t.status,
            emiPlanId: t.emiPlanId ?? null,
            emiInstalment: t.emiInstalment ?? null,
            reversalReference: reversal?.reference ?? null,
          };
        }),
        duplicateCandidates: duplicateCandidates(rows.filter((t) => !store.reversals.has(t.txnId))),
      });
    },
  );

  server.registerTool(
    'knowledge.search_policy',
    {
      title: 'Search bank policies',
      description: 'Keyword search over Meridian’s customer-service policy library (fees, waivers, disputes, EMI, statements, KYC).',
      inputSchema: z.object({ query: z.string().min(2).max(200), limit: z.number().int().min(1).max(5).optional() }),
      outputSchema: z.object({
        query: z.string(),
        results: z.array(
          z.object({
            policyId: z.string(),
            title: z.string(),
            version: z.string(),
            effectiveFrom: z.string(),
            summary: z.string(),
            excerpt: z.string(),
            score: z.number(),
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, limit }) => {
      const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
      const results = searchPolicies(query, limit ?? 3).map(({ policy, score }) => {
        const lines = policy.body.split('\n');
        const hits = lines.filter((l) => terms.some((t) => l.toLowerCase().includes(t)));
        return {
          policyId: policy.policyId,
          title: policy.title,
          version: policy.version,
          effectiveFrom: policy.effectiveFrom,
          summary: policy.summary,
          excerpt: (hits.length ? hits : lines).slice(0, 2).join('\n'),
          score,
        };
      });
      return ok({ query, results });
    },
  );
}
