import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Res } from '@nestjs/common';
import { Permission, can, type Principal } from '@ocso/auth';
import { ApprovalService, DestinationInput, DestinationPatch, NotificationDestinationService, WithApproval, requestStagedApproval, type ActorContext } from '@ocso/application';
import type { Response } from 'express';
import { z } from 'zod';
import { Actor, Authenticated, CurrentPrincipal, RequireAnyPermission, RequirePermission } from '../../common/decorators.js';
import { approvalResponse } from '../approvals/approval-response.js';
import { createDraft, proposeOnly, withApprovalState, OptionalApproval, type ApprovalBody } from '../settings/platform-approvals.js';

const CreateBody = DestinationInput.extend(WithApproval.shape);
type CreateBody = z.infer<typeof CreateBody>;
const PatchBody = DestinationPatch.extend(WithApproval.shape);
type PatchBody = z.infer<typeof PatchBody>;

/**
 * Alert delivery targets. Secrets are write-only: accepted on create/update, never returned.
 * Maker–checker (PM/research/11 §4, approvals.check.platform): a destination is created disabled (a draft);
 * enabling is an ACTIVATE proposal, deleting a DELETE proposal, and once approved every edit is an UPDATE
 * proposal whose new secret travels as a ref. Disabling is immediate.
 */
@Controller('v1/notification-destinations')
export class NotificationDestinationsController {
  constructor(
    @Inject(NotificationDestinationService) private readonly destinations: NotificationDestinationService,
    @Inject(ApprovalService) private readonly approvals: ApprovalService,
  ) {}

  /** Managers and rule editors (to attach destinations); configuration and approval state only for managers. */
  @Get()
  @Authenticated()
  async list(@Actor() actor: ActorContext, @CurrentPrincipal() principal: Principal) {
    const rows = await this.destinations.list(actor);
    return can(principal, Permission.NOTIFICATION_DESTINATIONS_MANAGE) ? withApprovalState(this.approvals, principal, 'notification_destination', rows) : rows;
  }

  /**
   * Registered destination kinds: label, config form (JSON Schema), secret
   * field and the lifecycle events each receives. Same audience as the list.
   */
  @Get('kinds')
  @RequireAnyPermission(Permission.NOTIFICATION_DESTINATIONS_MANAGE, Permission.ALERT_RULES_TECHNICAL_MANAGE, Permission.ALERT_RULES_BUSINESS_MANAGE)
  kinds(@Actor() actor: ActorContext) {
    return this.destinations.kinds(actor);
  }

  @Get(':id')
  @RequirePermission(Permission.NOTIFICATION_DESTINATIONS_MANAGE)
  async get(@Actor() actor: ActorContext, @CurrentPrincipal() principal: Principal, @Param('id', { schema: z.uuid() }) id: string) {
    return (await withApprovalState(this.approvals, principal, 'notification_destination', [await this.destinations.get(actor, id)]))[0];
  }

  /** A disabled draft (201); `enabled: true` with `approval` also submits its activation (202). */
  @Post()
  @RequirePermission(Permission.NOTIFICATION_DESTINATIONS_MANAGE)
  create(@Actor() actor: ActorContext, @Body({ schema: CreateBody }) body: CreateBody, @Res({ passthrough: true }) res: Response) {
    const { approval, ...input } = body;
    return createDraft(res, { approvals: this.approvals, actor, kind: 'notification_destination', live: input.enabled, approval, create: () => this.destinations.create(actor, input) });
  }

  /** `enabled: false` disables at once; `enabled: true` is an ACTIVATE proposal; other fields: draft direct, else UPDATE proposal. */
  @Patch(':id')
  @RequirePermission(Permission.NOTIFICATION_DESTINATIONS_MANAGE)
  async update(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: PatchBody }) body: PatchBody, @Res({ passthrough: true }) res: Response) {
    const { approval, enabled, ...edit } = body;
    const hasEdit = Object.values(edit).some((v) => v !== undefined);
    if (enabled === false) await this.destinations.disable(actor, id);
    if (enabled === true) {
      if (hasEdit) await this.destinations.update(actor, id, edit);
      return proposeOnly(res, this.approvals, actor, { kind: 'notification_destination', id, action: 'ACTIVATE' }, approval);
    }
    if (!hasEdit) return this.destinations.get(actor, id);
    return approvalResponse(
      res,
      requestStagedApproval(this.approvals, actor, { objectKind: 'notification_destination', objectId: id, action: 'UPDATE' }, approval, () => this.destinations.update(actor, id, edit), () =>
        this.destinations.stageChange(actor, id, edit),
      ),
    );
  }

  /** Always a proposal (DELETE): 202 `{proposal}` with `approval`, else 409 approval_required. */
  @Delete(':id')
  @RequirePermission(Permission.NOTIFICATION_DESTINATIONS_MANAGE)
  remove(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: OptionalApproval }) body: ApprovalBody, @Res({ passthrough: true }) res: Response) {
    return proposeOnly(res, this.approvals, actor, { kind: 'notification_destination', id, action: 'DELETE' }, body?.approval);
  }

  /** Sends a synthetic alert immediately and reports the adapter result. */
  @Post(':id/test')
  @HttpCode(200)
  @RequirePermission(Permission.NOTIFICATION_DESTINATIONS_MANAGE)
  test(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string) {
    return this.destinations.test(actor, id);
  }
}
