/** Small in-memory policy knowledge base for `knowledge.search_policy`. Fictional policies. */

export interface Policy {
  policyId: string;
  title: string;
  version: string;
  effectiveFrom: string;
  tags: string[];
  summary: string;
  body: string;
}

export const POLICIES: readonly Policy[] = [
  {
    policyId: 'CRD-114',
    title: 'Card fee and charge waivers',
    version: '3.2',
    effectiveFrom: '2026-01-01',
    tags: ['fee', 'waiver', 'late fee', 'annual fee', 'duplicate', 'emi', 'reversal', 'charges'],
    summary:
      'When card fees and charges may be waived, who may approve a waiver, and how charges caused by bank or merchant errors are reversed.',
    body: [
      'Late payment fee: an agent may waive one late payment fee of up to ₹1,000 in any rolling 12 months when the customer has no other default in that period.',
      'Annual fee: Priority customers whose card spend in the card year exceeds ₹3,00,000 get the annual fee waived automatically; manual waivers need a CS Lead.',
      'Duplicate authorisations (including duplicate EMI instalments caused by a merchant terminal): reverse the duplicate leg in full. No fee, interest or GST may be charged on the duplicate amount; any such charges are waived without approval.',
      'Reversals and waivers above ₹5,000 require a two-step confirmation by a human agent before they are executed. Reversal credits reach the card within 3 working days; the EMI schedule is unchanged.',
      'Always quote the reversal reference to the customer and record the policy id CRD-114 on the case.',
    ].join('\n'),
  },
  {
    policyId: 'CRD-101',
    title: 'Duplicate and erroneous card transactions',
    version: '2.0',
    effectiveFrom: '2025-07-01',
    tags: ['duplicate', 'erroneous', 'double debit', 'reversal', 'merchant'],
    summary: 'How to confirm a duplicate debit against the card ledger and when to reverse versus raise a dispute.',
    body: [
      'Confirm a duplicate when two settled debits share amount, merchant and value date, and the merchant batch shows a single purchase.',
      'Settled duplicates are reversed by the bank (see CRD-114). Pending duplicates normally drop off within 7 days and must not be reversed.',
      'If the merchant disputes the duplicate, raise a chargeback case under DSP-310 instead of reversing.',
    ].join('\n'),
  },
  {
    policyId: 'EMI-207',
    title: 'EMI schedules, changes and foreclosure',
    version: '1.4',
    effectiveFrom: '2025-11-15',
    tags: ['emi', 'instalment', 'schedule', 'foreclosure', 'autopay'],
    summary: 'EMI instalments debit on the same day each month; foreclosure is allowed after 3 instalments with a 2% fee.',
    body: [
      'Instalments are debited on the same calendar day each month on the card the plan was booked on.',
      'A reversed duplicate instalment does not change the schedule or the count of paid instalments.',
      'Foreclosure is permitted after three paid instalments; the foreclosure fee is 2% of the outstanding principal plus GST.',
    ].join('\n'),
  },
  {
    policyId: 'DSP-310',
    title: 'Chargebacks and card disputes',
    version: '4.1',
    effectiveFrom: '2025-09-01',
    tags: ['dispute', 'chargeback', 'fraud', 'not received'],
    summary: 'Dispute cases must be raised within 120 days of the transaction; the bank responds within 7 working days.',
    body: [
      'Raise a dispute case within 120 days of the value date. Fraud disputes require the card to be blocked first.',
      'The bank acknowledges within 1 working day and resolves or escalates to the network within 7 working days.',
    ].join('\n'),
  },
  {
    policyId: 'STM-020',
    title: 'Statement requests',
    version: '1.1',
    effectiveFrom: '2025-04-01',
    tags: ['statement', 'pdf', 'email', 'whatsapp'],
    summary: 'Card statements for the last 24 months can be sent as password-protected PDFs to the registered email or WhatsApp number.',
    body: 'Statements are only ever sent to contact points registered on the customer record. The PDF password is the customer date of birth (DDMMYYYY).',
  },
  {
    policyId: 'KYC-005',
    title: 'Identity verification before disclosure',
    version: '2.3',
    effectiveFrom: '2025-02-01',
    tags: ['kyc', 'identity', 'verification', 'disclosure'],
    summary: 'Verify the customer (registered channel plus one knowledge factor) before disclosing account details.',
    body: 'A conversation on the registered WhatsApp number counts as one factor; ask for the last four digits of the card or the date of birth as the second.',
  },
];

const tokenize = (s: string): string[] => s.toLowerCase().match(/[a-z0-9₹]+/g) ?? [];

/** Keyword relevance: title ×3, tags ×2, summary/body ×1. Deterministic ordering (score, then id). */
export function searchPolicies(query: string, limit: number): Array<{ policy: Policy; score: number }> {
  const terms = [...new Set(tokenize(query))];
  return POLICIES.map((policy) => {
    const title = tokenize(policy.title);
    const tags = tokenize(policy.tags.join(' '));
    const text = tokenize(`${policy.policyId} ${policy.summary} ${policy.body}`);
    const score = terms.reduce(
      (acc, t) => acc + (title.includes(t) ? 3 : 0) + (tags.includes(t) ? 2 : 0) + (text.includes(t) ? 1 : 0),
      0,
    );
    return { policy, score };
  })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.policy.policyId.localeCompare(b.policy.policyId))
    .slice(0, limit);
}
