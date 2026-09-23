import { findCustomer } from './data/customers.js';
import { findTransaction } from './data/transactions.js';

/**
 * In-memory mutable state for the write tools. Identifiers come from
 * counters seeded to match the OCSO design (first reversal = RVSL-5521904),
 * and the business date is fixed so every run is reproducible.
 */

export interface ReversalRecord {
  reference: string;
  txnId: string;
  cif: string;
  amountMinor: number;
  reason: string;
  status: 'ACCEPTED';
  expectedCreditBy: string;
}

export interface DisputeCase {
  caseId: string;
  cif: string;
  txnId: string;
  reason: string;
  description: string;
  status: 'OPEN';
  slaDueDate: string;
}

export interface StatementDelivery {
  deliveryId: string;
  cif: string;
  cardLast4: string;
  month: string;
  channel: 'WHATSAPP' | 'EMAIL';
  destinationMasked: string;
  status: 'QUEUED';
}

export type StoreResult<T> = { ok: true; value: T; replayed: boolean } | { ok: false; error: string };

function addWorkingDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}

export class MeridianStore {
  readonly reversals = new Map<string, ReversalRecord>();
  readonly disputes: DisputeCase[] = [];
  readonly statements: StatementDelivery[] = [];
  private readonly idempotent = new Map<string, unknown>();
  private reversalSeq = 5_521_904;
  private disputeSeq = 1;
  private statementSeq = 7_730_001;

  constructor(readonly businessDate = '2026-03-18') {}

  /** Replay the stored result for (tool, key) or run `fn` once and remember its successful result. */
  private once<T>(tool: string, key: string | null, fn: () => StoreResult<T>): StoreResult<T> {
    const k = key ? `${tool}:${key}` : null;
    if (k && this.idempotent.has(k)) return { ok: true, value: this.idempotent.get(k) as T, replayed: true };
    const result = fn();
    if (k && result.ok) this.idempotent.set(k, result.value);
    return result;
  }

  reverseTransaction(input: { cif: string; txnId: string; amountMinor: number; reason: string }, key: string | null): StoreResult<ReversalRecord> {
    return this.once('payments.reverse_transaction', key, () => {
      const txn = findTransaction(input.txnId);
      if (!txn || txn.cif !== input.cif) return { ok: false, error: `Transaction ${input.txnId} not found for customer ${input.cif}.` };
      if (txn.type !== 'DEBIT' || txn.status !== 'SETTLED') return { ok: false, error: `Transaction ${input.txnId} is not a settled debit and cannot be reversed.` };
      if (this.reversals.has(txn.txnId)) return { ok: false, error: `Transaction ${input.txnId} has already been reversed (${this.reversals.get(txn.txnId)?.reference}).` };
      if (input.amountMinor > txn.amountMinor) return { ok: false, error: 'Reversal amount exceeds the original transaction amount.' };
      const record: ReversalRecord = {
        reference: `RVSL-${this.reversalSeq++}`,
        txnId: txn.txnId,
        cif: txn.cif,
        amountMinor: input.amountMinor,
        reason: input.reason,
        status: 'ACCEPTED',
        expectedCreditBy: addWorkingDays(this.businessDate, 3),
      };
      this.reversals.set(txn.txnId, record);
      return { ok: true, value: record, replayed: false };
    });
  }

  raiseDispute(input: { cif: string; txnId: string; reason: string; description: string }, key: string | null): StoreResult<DisputeCase> {
    return this.once('disputes.raise_case', key, () => {
      const txn = findTransaction(input.txnId);
      if (!txn || txn.cif !== input.cif) return { ok: false, error: `Transaction ${input.txnId} not found for customer ${input.cif}.` };
      const dispute: DisputeCase = {
        caseId: `DSP-${this.businessDate.replaceAll('-', '')}-${String(this.disputeSeq++).padStart(3, '0')}`,
        cif: input.cif,
        txnId: input.txnId,
        reason: input.reason,
        description: input.description,
        status: 'OPEN',
        slaDueDate: addWorkingDays(this.businessDate, 7),
      };
      this.disputes.push(dispute);
      return { ok: true, value: dispute, replayed: false };
    });
  }

  sendStatement(input: { cif: string; cardLast4: string; month: string; channel: 'WHATSAPP' | 'EMAIL' }, key: string | null): StoreResult<StatementDelivery> {
    return this.once('statements.send_pdf', key, () => {
      const customer = findCustomer(input.cif);
      if (!customer || !customer.cards.some((c) => c.last4 === input.cardLast4)) {
        return { ok: false, error: `No card ending ${input.cardLast4} for customer ${input.cif}.` };
      }
      if (input.month > this.businessDate.slice(0, 7)) return { ok: false, error: `No statement has been generated for ${input.month} yet.` };
      // Natural idempotency: the same statement to the same channel is only queued once.
      const existing = this.statements.find(
        (s) => s.cif === input.cif && s.cardLast4 === input.cardLast4 && s.month === input.month && s.channel === input.channel,
      );
      if (existing) return { ok: true, value: existing, replayed: true };
      const delivery: StatementDelivery = {
        deliveryId: `STMT-${this.statementSeq++}`,
        ...input,
        destinationMasked: input.channel === 'EMAIL' ? customer.emailMasked : customer.phoneMasked,
        status: 'QUEUED',
      };
      this.statements.push(delivery);
      return { ok: true, value: delivery, replayed: false };
    });
  }

  openDisputes(cif: string): DisputeCase[] {
    return this.disputes.filter((d) => d.cif === cif && d.status === 'OPEN');
  }
}
