/**
 * Formulas behind every business metric (docs/archive/specs/11 §3: "avoid a universal quality
 * score unless its method is explicit and auditable"). The same text is returned
 * in API responses as `definition`, so a number on screen can always be traced
 * back to the rows it came from.
 */
export const DEFINITIONS = {
  cohort: 'Conversations of the agent(s) whose opened_at falls inside the window. Conversation KPIs are computed over this cohort.',
  conversations: 'Count of conversations in the cohort.',
  containment:
    'Cohort conversations with no handoff row of any trigger (no human ever involved, including staff take-overs) / cohort conversations.',
  escalation:
    "Cohort conversations with at least one handoff whose trigger is not HUMAN_REQUEST (the agent, a rule, the customer or a policy asked for a human) / cohort conversations. Staff take-overs lower containment but are not escalations.",
  resolution: 'Cohort conversations whose control state is RESOLVED at query time / cohort conversations.',
  firstResponseAi:
    "Median, over cohort conversations, of seconds from the first CUSTOMER message to the first AGENT message after it (interactions.created_at). Conversations without an agent reply are excluded.",
  slaBreaches:
    'Cohort conversations that are waiting for a human (ESCALATION_REQUESTED / WAITING_FOR_HUMAN) past sla_due_at, or whose first human response came after sla_due_at.',
  toolFailure:
    'Agent tool calls on cohort conversations with status FAILED / tool calls that finished (SUCCEEDED + FAILED). Denied and expired calls are policy outcomes, not failures.',
  csat: 'Arithmetic mean of csat_responses.score (1–5) received inside the window; n = number of responses.',
  timeToResolution: 'Median of resolved_at − opened_at over cohort conversations currently RESOLVED.',
  reopen:
    'Cohort conversations with reopen_count > 0 / cohort conversations resolved at least once (RESOLVED now or reopened). Customer reopens only happen inside the ingress reopen window (72 h); staff reopens count regardless of elapsed time.',
  costPerConversation:
    'Sum of usage_events.cost_micros for the agent(s) inside the window (all purposes: turns, summaries, classifiers; model cost only, tools are not priced) / cohort conversations. Events without a price are not counted.',
  handlingTime:
    'resolved_at − opened_at of cohort conversations currently RESOLVED, bucketed; human-handled = the conversation has at least one handoff, otherwise AI-handled.',
  escalationReasons: 'Handoffs (trigger ≠ HUMAN_REQUEST) on cohort conversations grouped by (reason_code, trigger).',
  insightTopics:
    'conversation_insights rows of cohort conversations (classifier output with method_version) grouped by case/whitespace-normalized label. Only analyzed conversations are counted (see coverage).',
  knowledgeGapNew: 'A knowledge gap is new when its normalized label was first seen (min generated_at over all insights of the scope) inside the window.',
  tags: 'Cohort conversations carrying each tag, as the tags are now (staff set them in the workspace or on resolve); a conversation with several tags counts once per tag. tagged = cohort conversations with at least one tag.',
  corrections: 'prompt_corrections with status OPEN or STAGED, most frequently observed first.',
  insightCandidates: 'Failure topics seen at least 3 times in the window: candidates for a prompt correction.',
  queueAvgWait:
    'Mean of handoff accepted_at − requested_at over handoffs (trigger ≠ HUMAN_REQUEST) routed to the queue on conversations opened inside the window.',
  queueState:
    "understaffed: waiting > 0 and fewer people on shift (availability AVAILABLE) than waiting conversations; watch: any conversation waiting past its SLA; otherwise ok.",
  escalationSpike:
    'Agent escalation rate in the window exceeds the previous same-length window by at least 5 percentage points, with at least 20 cohort conversations in both windows.',
  myFirstResponse:
    'Median over my pickups in the last 7 days (audited conversation.claim / conversation.accept_assignment / conversation.take_over) of seconds until my first customer-visible reply in that conversation. Pickups without a reply are excluded.',
  myCsat: 'Mean csat score received in the last 7 days for conversations in which I sent at least one customer-visible message.',
  resolvedToday: 'Distinct conversations I resolved (audited conversation.resolve) since the start of today in the deployment timezone.',
} as const;
export type DefinitionKey = keyof typeof DEFINITIONS;
