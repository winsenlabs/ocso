import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { findCustomer, formatInr, type EmiPlanSeed } from '../data/customers.js';
import { customerScopeError, type RequestContext } from '../request-context.js';
import type { MeridianStore } from '../store.js';
import { addMonths, CIF, fail, ok, READ_ONLY } from './result.js';

const CardOut = z.object({
  cardId: z.string(),
  product: z.string(),
  last4: z.string(),
  status: z.string(),
  creditLimitMinor: z.number().int(),
  usedMinor: z.number().int(),
  creditLimit: z.string(),
  used: z.string(),
});

const InstalmentOut = z.object({
  number: z.number().int(),
  dueDate: z.string(),
  amountMinor: z.number().int(),
  status: z.enum(['PAID', 'DUE', 'UPCOMING']),
});

const PlanOut = z.object({
  planId: z.string(),
  description: z.string(),
  merchant: z.string(),
  cardLast4: z.string(),
  instalmentMinor: z.number().int(),
  instalment: z.string(),
  instalmentsTotal: z.number().int(),
  instalmentsPaid: z.number().int(),
  autopay: z.boolean(),
  nextDueDate: z.string().nullable(),
});

function nextDue(plan: EmiPlanSeed): string | null {
  return plan.instalmentsPaid < plan.instalmentsTotal ? addMonths(plan.firstDueDate, plan.instalmentsPaid) : null;
}

function planSummary(plan: EmiPlanSeed): z.infer<typeof PlanOut> {
  return {
    planId: plan.planId,
    description: plan.description,
    merchant: plan.merchant,
    cardLast4: plan.cardLast4,
    instalmentMinor: plan.instalmentMinor,
    instalment: formatInr(plan.instalmentMinor),
    instalmentsTotal: plan.instalmentsTotal,
    instalmentsPaid: plan.instalmentsPaid,
    autopay: plan.autopay,
    nextDueDate: nextDue(plan),
  };
}

export function registerCustomerTools(server: McpServer, store: MeridianStore, ctx: RequestContext): void {
  server.registerTool(
    'crm.get_customer',
    {
      title: 'Get customer profile',
      description: 'Look up a customer by CIF: profile, KYC status, cards, EMI plans and open disputes. Contact details are masked.',
      inputSchema: z.object({ cif: CIF }),
      outputSchema: z.object({
        cif: z.string(),
        name: z.string(),
        segment: z.string(),
        customerSince: z.number().int(),
        phoneMasked: z.string(),
        emailMasked: z.string(),
        languages: z.array(z.string()),
        riskRating: z.string(),
        kycStatus: z.string(),
        cards: z.array(CardOut),
        emiPlans: z.array(PlanOut),
        openDisputes: z.array(z.object({ caseId: z.string(), txnId: z.string(), status: z.string() })),
      }),
      annotations: READ_ONLY,
    },
    async ({ cif }) => {
      const scope = customerScopeError(ctx, cif);
      if (scope) return fail(scope);
      const c = findCustomer(cif);
      if (!c) return fail(`No customer with CIF ${cif}.`);
      return ok({
        cif: c.cif,
        name: c.name,
        segment: c.segment,
        customerSince: c.customerSince,
        phoneMasked: c.phoneMasked,
        emailMasked: c.emailMasked,
        languages: c.languages,
        riskRating: c.riskRating,
        kycStatus: c.kycStatus,
        cards: c.cards.map((card) => ({ ...card, creditLimit: formatInr(card.creditLimitMinor), used: formatInr(card.usedMinor) })),
        emiPlans: c.emiPlans.map(planSummary),
        openDisputes: store.openDisputes(cif).map((d) => ({ caseId: d.caseId, txnId: d.txnId, status: d.status })),
      });
    },
  );

  server.registerTool(
    'emi.get_schedule',
    {
      title: 'Get EMI schedule',
      description: 'Instalment schedule for a customer’s EMI plans (all plans, or one plan by id).',
      inputSchema: z.object({ cif: CIF, planId: z.string().regex(/^EMI-\d+-\d{2}$/).optional() }),
      outputSchema: z.object({
        cif: z.string(),
        plans: z.array(PlanOut.extend({ instalments: z.array(InstalmentOut) })),
      }),
      annotations: READ_ONLY,
    },
    async ({ cif, planId }) => {
      const scope = customerScopeError(ctx, cif);
      if (scope) return fail(scope);
      const c = findCustomer(cif);
      if (!c) return fail(`No customer with CIF ${cif}.`);
      const plans = c.emiPlans.filter((p) => !planId || p.planId === planId);
      if (planId && plans.length === 0) return fail(`No EMI plan ${planId} for customer ${cif}.`);
      return ok({
        cif,
        plans: plans.map((p) => ({
          ...planSummary(p),
          instalments: Array.from({ length: p.instalmentsTotal }, (_, i) => ({
            number: i + 1,
            dueDate: addMonths(p.firstDueDate, i),
            amountMinor: p.instalmentMinor,
            status: i < p.instalmentsPaid ? ('PAID' as const) : i === p.instalmentsPaid ? ('DUE' as const) : ('UPCOMING' as const),
          })),
        })),
      });
    },
  );
}
