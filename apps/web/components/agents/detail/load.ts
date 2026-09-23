import 'server-only';
import { Permission } from '@ocso/auth';
import { getAgentTools, getPrompt, listAgentAlerts, optional } from '@/lib/api/agents';
import type { Session } from '@/lib/session';
import type { AgentAlert, AgentDetail, AgentTool, PromptState, PromptVersion } from '../data/agent-schemas';
import { loadAgentOptions, type AgentOptions } from '../data/options';

/** What every agent tab may do, from the session's permissions (the API enforces the same). */
export interface AgentCan {
  manage: boolean;
  /** Reassign owning teams across any team (Tech Admin, ADR-026). */
  assignOwner: boolean;
  editPrompt: boolean;
  activate: boolean;
  tools: boolean;
  escalation: boolean;
  corrections: boolean;
  reviews: boolean;
  evaluations: boolean;
  analytics: boolean;
  channels: boolean;
  queues: boolean;
  providers: boolean;
}

export interface AgentPageData {
  session: Session;
  agent: AgentDetail;
  prompt: PromptState;
  /** The active (live) prompt version, if any. */
  live: PromptVersion | null;
  options: AgentOptions;
  tools: AgentTool[] | null;
  alerts: AgentAlert[] | null;
  timeZone: string;
  can: AgentCan;
}

export function agentCan(session: Session): AgentCan {
  const has = (p: Permission) => session.permissions.has(p);
  return {
    manage: has(Permission.AGENTS_MANAGE),
    assignOwner: has(Permission.AGENTS_ASSIGN_OWNER),
    editPrompt: has(Permission.PROMPTS_EDIT),
    activate: has(Permission.PROMPTS_ACTIVATE),
    tools: has(Permission.AGENT_TOOLS_MANAGE),
    escalation: has(Permission.ESCALATION_MANAGE),
    corrections: has(Permission.CORRECTIONS_MANAGE),
    reviews: has(Permission.REVIEWS_MANAGE),
    evaluations: has(Permission.EVALUATIONS_RUN),
    analytics: has(Permission.ANALYTICS_BUSINESS_READ),
    channels: has(Permission.CHANNELS_READ),
    queues: has(Permission.QUEUES_READ),
    providers: has(Permission.PROVIDERS_READ),
  };
}

/** Header data shared by every tab: prompt versions, choices, tool grants and open alerts. */
export async function loadAgentPage(session: Session, agent: AgentDetail): Promise<AgentPageData> {
  const [prompt, options, tools, alerts] = await Promise.all([
    getPrompt(agent.id),
    loadAgentOptions(session),
    optional(getAgentTools(agent.id)),
    optional(listAgentAlerts(agent.id)),
  ]);
  return {
    session,
    agent,
    prompt,
    live: prompt.versions.find((v) => v.id === agent.activePromptVersionId) ?? null,
    options,
    tools: tools?.tools ?? null,
    alerts: alerts?.items ?? null,
    timeZone: session.user.deployment.timezone,
    can: agentCan(session),
  };
}
