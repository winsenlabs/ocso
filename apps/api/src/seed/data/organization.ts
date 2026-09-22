import type { Role } from '@ocso/auth';

/**
 * Meridian Bank demo organization — names, teams, queues and SLAs match the
 * design mockups (design/01, 02, 03, 06). Emails use the reserved
 * `.example` TLD so nothing can ever be delivered to a real mailbox.
 */
export const ORG = {
  orgName: 'Meridian Bank',
  deploymentLabel: 'DEMO',
  regionLabel: 'ap-south-1',
  timezone: 'Asia/Kolkata',
  residencyZone: 'IN',
} as const;

export type TeamKey = 'cards' | 'hardship' | 'sales';

export const TEAMS: Record<TeamKey, { name: string; description: string }> = {
  cards: { name: 'Cards & EMI', description: 'Card, EMI and statement servicing; owns Tier 2 escalations and disputes.' },
  hardship: { name: 'Hardship', description: 'Financial hardship, restructuring and collections escalations.' },
  sales: { name: 'Sales', description: 'Loan and card sales callbacks from Arjun.' },
};

export interface DemoUser {
  key: 'admin' | 'lead' | 'exec1' | 'exec2';
  name: string;
  email: string;
  role: Role;
  teams: TeamKey[];
  languages: string[];
  skills: string[];
  maxConcurrent: number;
}

export const USERS: readonly DemoUser[] = [
  { key: 'admin', name: 'Tarun Shetty', email: 'tarun.shetty@meridian.example', role: 'PLATFORM_TECH_ADMIN', teams: [], languages: ['en'], skills: [], maxConcurrent: 8 },
  { key: 'lead', name: 'Anjali Rao', email: 'anjali.rao@meridian.example', role: 'CS_LEAD', teams: ['cards', 'hardship'], languages: ['en', 'mr', 'hi'], skills: ['cards', 'emi', 'disputes', 'hardship'], maxConcurrent: 6 },
  { key: 'exec1', name: 'Nikhil Menon', email: 'nikhil.menon@meridian.example', role: 'CS_EXEC', teams: ['cards'], languages: ['en', 'mr'], skills: ['cards', 'emi', 'disputes'], maxConcurrent: 8 },
  { key: 'exec2', name: 'Meera Pillai', email: 'meera.pillai@meridian.example', role: 'CS_EXEC', teams: ['hardship', 'sales'], languages: ['en', 'hi', 'ml'], skills: ['hardship', 'collections', 'sales'], maxConcurrent: 6 },
];

export type SlaKey = 'support' | 'sales';

/** Pickup targets are seconds per priority; resolution targets are per conversation type. */
export const SLA_POLICIES: Record<SlaKey, { name: string; firstHumanResponseSeconds: number; pickupSecondsByPriority: Record<string, number>; resolutionSecondsByType: Record<string, number> }> = {
  support: {
    name: 'Retail support · standard',
    firstHumanResponseSeconds: 15 * 60,
    pickupSecondsByPriority: { P1: 5 * 60, P2: 10 * 60, P3: 15 * 60, P4: 30 * 60 },
    resolutionSecondsByType: { SUPPORT: 4 * 3600, COLLECTIONS: 2 * 86_400 },
  },
  sales: {
    name: 'Sales callback',
    firstHumanResponseSeconds: 30 * 60,
    pickupSecondsByPriority: { P1: 10 * 60, P2: 30 * 60, P3: 60 * 60, P4: 4 * 3600 },
    resolutionSecondsByType: { SALES: 86_400 },
  },
};

export type QueueKey = 'cardsT2' | 'hardship' | 'disputes' | 'salesCallback';

export interface DemoQueue {
  name: string;
  description: string;
  mode: 'AUTO_ASSIGN' | 'OPEN_PICKUP';
  autoAssignAfterSeconds: number | null;
  requiredSkills: string[];
  languages: string[];
  sla: SlaKey;
  teams: TeamKey[];
}

export const QUEUES: Record<QueueKey, DemoQueue> = {
  cardsT2: {
    name: 'Cards & EMI · Tier 2',
    description: 'Refunds above agent authority, duplicate debits, repeated tool failures. Open pickup, then auto-assign after 90s.',
    mode: 'OPEN_PICKUP',
    autoAssignAfterSeconds: 90,
    requiredSkills: ['cards'],
    languages: ['en', 'mr', 'hi'],
    sla: 'support',
    teams: ['cards'],
  },
  hardship: {
    name: 'Hardship desk',
    description: 'Job loss, bereavement and financial hardship. Auto-assigned to the least-loaded available exec.',
    mode: 'AUTO_ASSIGN',
    autoAssignAfterSeconds: null,
    requiredSkills: ['hardship'],
    languages: ['en', 'hi'],
    sla: 'support',
    teams: ['hardship'],
  },
  disputes: {
    name: 'Disputes',
    description: 'Chargebacks, disputes and ombudsman mentions.',
    mode: 'OPEN_PICKUP',
    autoAssignAfterSeconds: 300,
    requiredSkills: ['disputes'],
    languages: ['en'],
    sla: 'support',
    teams: ['cards'],
  },
  salesCallback: {
    name: 'Sales callback',
    description: 'Qualified leads from Arjun who asked to talk to a person.',
    mode: 'OPEN_PICKUP',
    autoAssignAfterSeconds: null,
    requiredSkills: ['sales'],
    languages: ['en', 'hi'],
    sla: 'sales',
    teams: ['sales'],
  },
};

/** DEV_SCRIPTED provider (ADR-015) and the logical profiles agents reference (design/04). */
export const DEV_PROVIDER = { name: 'Scripted demo model', region: 'ap-south-1', residencyZone: 'IN', settings: { latencyMs: 250, chunkDelayMs: 20 } } as const;

export type ProfileKey = 'supportPrimary' | 'supportFast' | 'salesPrimary' | 'summarizer';

export const PROFILES: Record<ProfileKey, { name: string; description: string; model: string; maxOutputTokens: number; temperature: number; fallbackTo?: ProfileKey }> = {
  supportPrimary: { name: 'support-primary', description: 'Maya and Riya: customer-facing support turns', model: 'scripted-support-v1', maxOutputTokens: 1024, temperature: 0.2, fallbackTo: 'supportFast' },
  supportFast: { name: 'support-fast', description: 'Short turns, copilot suggestions and the internal agent', model: 'scripted-fast-v1', maxOutputTokens: 512, temperature: 0.2 },
  salesPrimary: { name: 'sales-primary', description: 'Arjun: product questions and lead qualification', model: 'scripted-sales-v1', maxOutputTokens: 1024, temperature: 0.4 },
  summarizer: { name: 'summarizer', description: 'Rolling conversation summaries and handover notes', model: 'scripted-summary-v1', maxOutputTokens: 600, temperature: 0 },
};
