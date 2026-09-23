/**
 * Deterministic card ledgers (seeded PRNG, no clock). Priya Deshmukh's card
 * •4417 carries the duplicate EMI authorisation from the OCSO design: two
 * settled ₹12,480 debits for instalment 4 of 9 on 14 March 2026, the later
 * one being TXN-8841-2290.
 */

export interface Transaction {
  txnId: string;
  cif: string;
  cardLast4: string;
  /** ISO timestamp, IST offset. */
  postedAt: string;
  valueDate: string;
  description: string;
  merchant: string;
  category: string;
  type: 'DEBIT' | 'CREDIT';
  amountMinor: number;
  status: 'SETTLED' | 'PENDING';
  emiPlanId?: string | undefined;
  emiInstalment?: number | undefined;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MERCHANTS: ReadonlyArray<[string, string]> = [
  ["Nature's Basket Koregaon Park", 'Groceries'],
  ['Indian Oil Baner', 'Fuel'],
  ['Swiggy', 'Food delivery'],
  ['Zomato', 'Food delivery'],
  ['Uber India', 'Transport'],
  ['Apollo Pharmacy Aundh', 'Health'],
  ['Starbucks FC Road', 'Dining'],
  ['BigBasket', 'Groceries'],
  ['Decathlon Wakad', 'Shopping'],
  ['Airtel Postpaid', 'Utilities'],
  ['BookMyShow', 'Entertainment'],
  ['Amazon Pay India', 'Shopping'],
];

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (day: number, h: number, m: number, s: number) => `2026-03-${pad(day)}T${pad(h)}:${pad(m)}:${pad(s)}+05:30`;

function randomRows(cif: string, last4: string, seed: number, count: number, days: [number, number]): Omit<Transaction, 'txnId'>[] {
  const rnd = mulberry32(seed);
  const rows: Omit<Transaction, 'txnId'>[] = [];
  for (let i = 0; i < count; i++) {
    const [merchant, category] = MERCHANTS[Math.floor(rnd() * MERCHANTS.length)] as [string, string];
    const day = days[0] + Math.floor(rnd() * (days[1] - days[0] + 1));
    const postedAt = iso(day, 8 + Math.floor(rnd() * 13), Math.floor(rnd() * 60), Math.floor(rnd() * 60));
    rows.push({
      cif,
      cardLast4: last4,
      postedAt,
      valueDate: postedAt.slice(0, 10),
      description: merchant.toUpperCase(),
      merchant,
      category,
      type: 'DEBIT',
      // ₹120 – ₹6,500, whole rupees; +i paise-free offset keeps amounts distinct.
      amountMinor: (120 + Math.floor(rnd() * 6_380) + i) * 100,
      status: 'SETTLED',
    });
  }
  return rows;
}

function emiRow(cif: string, last4: string, postedAt: string, planId: string, n: number, total: number, merchant: string, amountMinor: number): Omit<Transaction, 'txnId'> {
  return {
    cif,
    cardLast4: last4,
    postedAt,
    valueDate: postedAt.slice(0, 10),
    description: `EMI ${n}/${total} ${merchant.toUpperCase()}`,
    merchant,
    category: 'EMI',
    type: 'DEBIT',
    amountMinor,
    status: 'SETTLED',
    emiPlanId: planId,
    emiInstalment: n,
  };
}

function byTime(a: Omit<Transaction, 'txnId'>, b: Omit<Transaction, 'txnId'>): number {
  return a.postedAt < b.postedAt ? -1 : a.postedAt > b.postedAt ? 1 : 0;
}

function withIds(prefix: string, start: number, rows: Omit<Transaction, 'txnId'>[]): Transaction[] {
  return rows.map((r, i) => ({ txnId: `${prefix}-${start + i}`, ...r }));
}

function priyaLedger(): Transaction[] {
  const before = [
    ...randomRows('88214', '4417', 88214, 27, [1, 13]),
    emiRow('88214', '4417', iso(2, 6, 5, 11), 'EMI-88214-02', 6, 12, 'Reliance Digital Viman Nagar', 415_000),
    {
      cif: '88214', cardLast4: '4417', postedAt: iso(5, 11, 20, 0), valueDate: '2026-03-05', description: 'PAYMENT RECEIVED - THANK YOU',
      merchant: 'Meridian Bank', category: 'Payment', type: 'CREDIT' as const, amountMinor: 9_800_000, status: 'SETTLED' as const,
    },
  ].sort(byTime);
  const duplicatePair = [
    emiRow('88214', '4417', iso(14, 9, 12, 4), 'EMI-88214-01', 4, 9, 'Croma Kalyani Nagar', 1_248_000),
    emiRow('88214', '4417', iso(14, 9, 12, 41), 'EMI-88214-01', 4, 9, 'Croma Kalyani Nagar', 1_248_000),
  ];
  const after = randomRows('88214', '4417', 4417, 3, [15, 18]).sort(byTime);
  const last = after[after.length - 1];
  if (last) last.status = 'PENDING';
  // 29 + 2 + 3 = 34 rows; the pair lands on TXN-8841-2289 / TXN-8841-2290.
  return withIds('TXN-8841', 2260, [...before, ...duplicatePair, ...after]);
}

export const TRANSACTIONS: readonly Transaction[] = [
  ...priyaLedger(),
  ...withIds('TXN-5519', 1100, randomRows('90517', '2231', 90517, 12, [1, 18]).sort(byTime)),
  ...withIds('TXN-7302', 3400, randomRows('77340', '9902', 77340, 10, [1, 18]).sort(byTime)),
];

export function findTransaction(txnId: string): Transaction | undefined {
  return TRANSACTIONS.find((t) => t.txnId === txnId);
}
