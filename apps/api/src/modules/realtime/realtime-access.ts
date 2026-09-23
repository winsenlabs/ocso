import { Permission, can, type Principal } from '@ocso/auth';
import { assertAgentReadable, assertConversationAccess, type SettingsService } from '@ocso/application';
import type { Db } from '@ocso/db';
import type { OcsoEvent } from '@ocso/events';

const ALERT_TYPES = new Set(['alert.opened', 'alert.updated', 'alert.resolved']);

/**
 * Which realtime events one connection may receive, with a per-connection
 * authorization cache (30 s) so SSE fan-out stays cheap. Conversation events
 * use the same conversationScope as the inbox (no role shortcut, ADR-026);
 * alert and config events that concern an agent need that agent readable.
 */
export class RealtimeAccess {
  private readonly decisions = new Map<string, { ok: boolean; at: number }>();
  private readonly agents = new Map<string, { ok: boolean; at: number }>();

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly principal: Principal,
  ) {}

  async allows(event: OcsoEvent): Promise<boolean> {
    if (ALERT_TYPES.has(event.type)) {
      const kind = (event.payload as { kind?: string }).kind;
      const readable =
        kind === 'TECHNICAL'
          ? can(this.principal, Permission.ALERTS_TECHNICAL_READ)
          : kind === 'BUSINESS'
            ? can(this.principal, Permission.ALERTS_BUSINESS_READ)
            : // updated/resolved carry only the id; clients refetch through the audience-scoped GET.
              can(this.principal, Permission.ALERTS_BUSINESS_READ) || can(this.principal, Permission.ALERTS_TECHNICAL_READ);
      return readable && (await this.agentAllowed(event.agentId));
    }
    if (event.type === 'message_template.status_changed') {
      // The submitter's in-app notice; Tech admins see every channel's review results. Others get config.changed.
      const submittedBy = (event.payload as { submittedBy?: string | null }).submittedBy;
      return submittedBy === this.principal.userId || can(this.principal, Permission.CHANNELS_MANAGE);
    }
    if (!event.conversationId) {
      if (event.type !== 'config.changed' && event.type !== 'cache.invalidated') return false;
      if (!can(this.principal, Permission.SYSTEM_READ) && !can(this.principal, Permission.AGENTS_MANAGE)) return false;
      return this.agentAllowed(event.agentId);
    }
    if (!can(this.principal, Permission.CONVERSATIONS_READ)) return false;
    const cached = this.decisions.get(event.conversationId);
    if (cached && Date.now() - cached.at < 30_000) return cached.ok;
    let ok = true;
    try {
      const policy = await this.settings.deployment();
      await assertConversationAccess(this.db, this.principal, event.conversationId, { execsCanViewAiActive: policy.execsCanViewAiActive });
    } catch {
      ok = false;
    }
    this.decisions.set(event.conversationId, { ok, at: Date.now() });
    return ok;
  }

  /** Events about an agent reach only users who can read it (another team's agent stays invisible). */
  private async agentAllowed(agentId: string | undefined): Promise<boolean> {
    if (!agentId) return true;
    const cached = this.agents.get(agentId);
    if (cached && Date.now() - cached.at < 30_000) return cached.ok;
    const ok = await assertAgentReadable(this.db, this.principal, agentId).then(
      () => true,
      () => false,
    );
    this.agents.set(agentId, { ok, at: Date.now() });
    return ok;
  }
}
