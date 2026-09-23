import type { EscalationRuleInput } from '@ocso/application';
import type { PromptComponents } from '@ocso/prompt-compiler';
import type { LeadKey, ProfileKey, QueueKey, TeamKey } from './organization.js';
import { ARJUN_PROMPT, MAYA_PROMPT, RIYA_PROMPT } from './prompts.js';

export type AgentKey = 'maya' | 'arjun' | 'riya';

/** Escalation rule with its target queue referenced by key (resolved to ids at seed time). */
export type DemoEscalationRule = Omit<EscalationRuleInput, 'targetQueueId' | 'enabled'> & { queue: QueueKey };

export interface DemoAgent {
  slug: AgentKey;
  name: string;
  purpose: string;
  conversationType: 'SUPPORT' | 'SALES' | 'COLLECTIONS';
  description: string;
  profile: ProfileKey;
  queue: QueueKey;
  /** Owning teams (ADR-026): only Leads of these teams see and manage the agent. */
  owners: TeamKey[];
  /** The Lead (a member of an owning team) who builds and publishes it. */
  lead: LeadKey;
  multimodal: { imageInput: boolean; documentInput: boolean; audioInput: boolean; maxMediaPerTurn: number };
  /** Reason recorded on the curated prompt version (also the idempotency key for that step). */
  promptReason: string;
  prompt: PromptComponents;
  /** Linked to the demo web chat channel. */
  webchat: boolean;
  escalations: DemoEscalationRule[];
}

const humanRequest = (queue: QueueKey, priority: 'P2' | 'P3'): DemoEscalationRule => ({
  name: 'Customer asks for a human',
  trigger: 'CUSTOMER_REQUEST',
  condition: { customerRequestsHuman: true },
  mode: 'OPEN_PICKUP',
  queue,
  priority,
});

/** Maya's rules mirror the design/02 Escalation tab. */
const MAYA_RULES: DemoEscalationRule[] = [
  { name: 'Refund amount above ₹5,000', trigger: 'SENSITIVE_ACTION', condition: { amountAbove: 5000 }, mode: 'OPEN_PICKUP', queue: 'cardsT2', priority: 'P1' },
  {
    name: 'Hardship / job loss language',
    trigger: 'INTENT',
    condition: { keywords: ['job loss', 'lost my job', 'hardship', 'bereavement', 'cannot pay'] },
    mode: 'AUTO_ASSIGN',
    queue: 'hardship',
    priority: 'P1',
  },
  { name: 'Dispute or ombudsman mentioned', trigger: 'INTENT', condition: { keywords: ['dispute', 'chargeback', 'ombudsman'] }, mode: 'AUTO_ASSIGN', queue: 'disputes', priority: 'P2' },
  { name: 'Two consecutive tool failures', trigger: 'TOOL_FAILURE', condition: { consecutiveToolFailures: 2 }, mode: 'OPEN_PICKUP', queue: 'cardsT2', priority: 'P2' },
  humanRequest('cardsT2', 'P3'),
  { name: 'Low policy confidence', trigger: 'LOW_CONFIDENCE', condition: {}, mode: 'OPEN_PICKUP', queue: 'cardsT2', priority: 'P3' },
  { name: 'Abusive language', trigger: 'RISK', condition: { keywords: ['idiot', 'useless bank', 'fraudsters'] }, mode: 'AUTO_ASSIGN', queue: 'cardsT2', priority: 'P2' },
];

export const AGENTS: readonly DemoAgent[] = [
  {
    slug: 'maya',
    name: 'Maya',
    purpose: 'customer support for cards, EMI and statements',
    conversationType: 'SUPPORT',
    description:
      'Handles card, EMI and statement questions for retail customers on WhatsApp and web chat. Resolves end to end where policy allows, escalates refunds above ₹5,000 and any hardship or dispute language to the Cards & EMI queue.',
    profile: 'supportPrimary',
    queue: 'cardsT2',
    owners: ['cards'],
    lead: 'lead',
    multimodal: { imageInput: true, documentInput: true, audioInput: false, maxMediaPerTurn: 4 },
    promptReason: 'Meridian support prompt: duplicate-debit path, CRD-114 and hardship rules',
    prompt: MAYA_PROMPT,
    webchat: true,
    escalations: MAYA_RULES,
  },
  {
    slug: 'arjun',
    name: 'Arjun',
    purpose: 'personal loan and credit card sales',
    conversationType: 'SALES',
    description: 'Answers product questions on personal loans and cards, compares options honestly and books sales callbacks for qualified customers.',
    profile: 'salesPrimary',
    queue: 'salesCallback',
    owners: ['sales'],
    lead: 'lead2',
    multimodal: { imageInput: false, documentInput: false, audioInput: false, maxMediaPerTurn: 0 },
    promptReason: 'Meridian sales prompt: fair-practices code and callback rules',
    prompt: ARJUN_PROMPT,
    webchat: true,
    escalations: [humanRequest('salesCallback', 'P3')],
  },
  {
    slug: 'riya',
    name: 'Riya',
    purpose: 'collections and payment plans',
    conversationType: 'COLLECTIONS',
    description: 'Reminds customers of overdue card and EMI payments, agrees payment dates and hands hardship cases to the Hardship desk on first mention.',
    profile: 'supportPrimary',
    queue: 'hardship',
    owners: ['hardship'],
    lead: 'lead',
    multimodal: { imageInput: false, documentInput: true, audioInput: false, maxMediaPerTurn: 2 },
    promptReason: 'Meridian collections prompt: hardship stop and contact-hours policy',
    prompt: RIYA_PROMPT,
    webchat: false,
    escalations: [
      {
        name: 'Hardship language',
        trigger: 'INTENT',
        condition: { keywords: ['job loss', 'lost my job', 'hardship', 'hospital', 'bereavement'] },
        mode: 'AUTO_ASSIGN',
        queue: 'hardship',
        priority: 'P1',
      },
      humanRequest('hardship', 'P2'),
    ],
  },
];
