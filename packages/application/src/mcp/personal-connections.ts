import { and, asc, eq, isNotNull, isNull, ne } from 'drizzle-orm';
import { Permission } from '@ocso/auth';
import { conflict } from '@ocso/domain';
import { mcpConnections, uuidv7, type Db } from '@ocso/db';
import { recordAudit } from '../audit/audit.js';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';
import { requirePermission } from './access.js';
import { notATemplate } from './errors.js';
import { CreatePersonalConnectionInput } from './inputs.js';
import { isTemplate, isUniqueViolation, loadConnection } from './records.js';
import { viewOf, viewsOf, type ConnectionView } from './views.js';

/**
 * Personal (USER-scope) connections (docs/08 §3): a user attaches their own
 * credentials to an admin-published template. The instance is owned by that
 * user and serves only their human tool actions and the internal agent —
 * virtual agents never use USER connections (the runtime catalogue filters
 * on SHARED). Discovery, authentication, health and deletion go through
 * McpConnectionService, whose access rules restrict them to the owner.
 */
export class PersonalConnectionService {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Templates a user can connect to: published by an admin and not disabled. */
  async listTemplates(actor: ActorContext): Promise<ConnectionView[]> {
    requirePermission(actor, Permission.MCP_CONNECT_PERSONAL);
    const rows = await this.db
      .select()
      .from(mcpConnections)
      .where(
        and(
          eq(mcpConnections.scope, 'USER'),
          isNull(mcpConnections.ownerUserId),
          isNotNull(mcpConnections.approvedAt),
          ne(mcpConnections.status, 'DISABLED'),
        ),
      )
      .orderBy(asc(mcpConnections.name));
    return viewsOf(this.db, rows);
  }

  async listMine(actor: ActorContext): Promise<ConnectionView[]> {
    const principal = requirePermission(actor, Permission.MCP_CONNECT_PERSONAL);
    const rows = await this.db.select().from(mcpConnections).where(eq(mcpConnections.ownerUserId, principal.userId)).orderBy(asc(mcpConnections.name));
    return viewsOf(this.db, rows);
  }

  async create(actor: ActorContext, raw: CreatePersonalConnectionInput): Promise<ConnectionView> {
    const principal = requirePermission(actor, Permission.MCP_CONNECT_PERSONAL);
    const input = CreatePersonalConnectionInput.parse(raw);
    const template = await loadConnection(this.db, input.templateId);
    if (!isTemplate(template) || !template.approvedAt || template.status === 'DISABLED') throw notATemplate(template.id);
    const id = uuidv7();
    const now = this.now();
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(mcpConnections)
          .values({
            id,
            name: template.name,
            description: template.description,
            url: template.url,
            network: template.network,
            scope: 'USER',
            ownerUserId: principal.userId,
            templateId: template.id,
            status: 'PENDING',
            confirmationPolicy: template.confirmationPolicy,
            allowedAgentIds: [],
            sendCustomerClaims: false,
            forwardUserToken: false,
            healthCheckSeconds: template.healthCheckSeconds,
            createdBy: principal.userId,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        await recordAudit(tx, actor, {
          action: 'mcp.personal.create',
          targetType: 'mcp_connection',
          targetId: id,
          summary: `Created personal connection to ${template.name}`,
          after: { templateId: template.id, url: template.url },
        });
        await emitEvent(tx, actor, 'config.changed', { area: 'mcp', entityId: id });
        return viewOf(tx, row!);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('mcp_personal_connection_exists', `You already have a connection to ${template.name}`);
      throw err;
    }
  }
}
