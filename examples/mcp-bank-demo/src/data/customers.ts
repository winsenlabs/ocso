/**
 * Deterministic seed data for the Meridian core demo. Fictional people and
 * masked contact details only. Amounts are in paise (INR minor units).
 */

export interface Card {
  cardId: string;
  product: string;
  last4: string;
  status: 'ACTIVE' | 'BLOCKED';
  creditLimitMinor: number;
  usedMinor: number;
}

export interface EmiPlanSeed {
  planId: string;
  description: string;
  merchant: string;
  cardLast4: string;
  instalmentMinor: number;
  instalmentsTotal: number;
  instalmentsPaid: number;
  /** ISO date of instalment 1; later instalments fall on the same day of each following month. */
  firstDueDate: string;
  autopay: boolean;
}

export interface Customer {
  cif: string;
  name: string;
  segment: 'Priority' | 'Preferred' | 'Classic';
  customerSince: number;
  phoneMasked: string;
  emailMasked: string;
  languages: string[];
  riskRating: 'Low' | 'Medium' | 'High';
  kycStatus: 'VERIFIED' | 'PENDING';
  cards: Card[];
  emiPlans: EmiPlanSeed[];
}

export const CUSTOMERS: readonly Customer[] = [
  {
    cif: '88214',
    name: 'Priya Deshmukh',
    segment: 'Priority',
    customerSince: 2019,
    phoneMasked: '+91 98•••41208',
    emailMasked: 'pr•••@example.in',
    languages: ['English', 'Marathi'],
    riskRating: 'Low',
    kycStatus: 'VERIFIED',
    cards: [
      { cardId: 'CARD-88214-01', product: 'Meridian Signature', last4: '4417', status: 'ACTIVE', creditLimitMinor: 45_000_000, usedMinor: 11_240_000 },
    ],
    emiPlans: [
      {
        planId: 'EMI-88214-01',
        description: 'Washing machine',
        merchant: 'Croma Kalyani Nagar',
        cardLast4: '4417',
        instalmentMinor: 1_248_000,
        instalmentsTotal: 9,
        instalmentsPaid: 4,
        firstDueDate: '2025-12-14',
        autopay: true,
      },
      {
        planId: 'EMI-88214-02',
        description: 'Laptop',
        merchant: 'Reliance Digital Viman Nagar',
        cardLast4: '4417',
        instalmentMinor: 415_000,
        instalmentsTotal: 12,
        instalmentsPaid: 6,
        firstDueDate: '2025-10-02',
        autopay: true,
      },
    ],
  },
  {
    cif: '90517',
    name: 'Rakesh Iyer',
    segment: 'Preferred',
    customerSince: 2021,
    phoneMasked: '+91 99•••07731',
    emailMasked: 'ra•••@example.in',
    languages: ['English', 'Tamil'],
    riskRating: 'Low',
    kycStatus: 'VERIFIED',
    cards: [{ cardId: 'CARD-90517-01', product: 'Meridian Rewards', last4: '2231', status: 'ACTIVE', creditLimitMinor: 20_000_000, usedMinor: 3_415_000 }],
    emiPlans: [],
  },
  {
    cif: '77340',
    name: 'Ananya Rao',
    segment: 'Classic',
    customerSince: 2023,
    phoneMasked: '+91 97•••55610',
    emailMasked: 'an•••@example.in',
    languages: ['English', 'Kannada'],
    riskRating: 'Medium',
    kycStatus: 'PENDING',
    cards: [{ cardId: 'CARD-77340-01', product: 'Meridian Platinum', last4: '9902', status: 'ACTIVE', creditLimitMinor: 15_000_000, usedMinor: 6_020_000 }],
    emiPlans: [
      {
        planId: 'EMI-77340-01',
        description: 'Smartphone',
        merchant: 'Vijay Sales Indiranagar',
        cardLast4: '9902',
        instalmentMinor: 329_900,
        instalmentsTotal: 12,
        instalmentsPaid: 7,
        firstDueDate: '2025-08-20',
        autopay: false,
      },
    ],
  },
];

export function findCustomer(cif: string): Customer | undefined {
  return CUSTOMERS.find((c) => c.cif === cif);
}

/** Format paise as Indian-grouped rupees, e.g. 1248000 → "₹12,480". */
export function formatInr(minor: number): string {
  const rupees = Math.floor(Math.abs(minor) / 100);
  const paise = Math.abs(minor) % 100;
  const s = String(rupees);
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const grouped = rest ? `${rest},${last3}` : last3;
  return `${minor < 0 ? '-' : ''}₹${grouped}${paise ? `.${String(paise).padStart(2, '0')}` : ''}`;
}
