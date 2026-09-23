import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { Permission, type Principal } from '@ocso/auth';
import { ApprovalService, WEBHOOK_EVENT_TYPES, WebhookDeliveryService, WebhookInput, WebhookPatch, WebhookService, WithApproval, requestApproval, type ActorContext } from '@ocso/application';
import type { Response } from 'express';
import { z } from 'zod';
import { Actor, CurrentPrincipal, RequirePermission } from '../../common/decorators.js';
import { approvalResponse } from '../approvals/approval-response.js';
import { createDraft, proposeOnly, withApprovalState, OptionalApproval, type ApprovalBody } from '../settings/platform-approvals.js';

const Id = z.uuid();
const DeliveriesQuery = z.object({ status: z.enum(['PENDING', 'SENT', 'FAILED']).optional() });
type DeliveriesQuery = z.infer<typeof DeliveriesQuery>;
const CreateBody = WebhookInput.extend(WithApproval.shape);
type CreateBody = z.infer<typeof CreateBody>;
const PatchBody = WebhookPatch.extend(WithApproval.shape);
type PatchBody = z.infer<typeof PatchBody>;

/**
 * Outbound webhooks. Maker–checker (PM/research/11 §4, approvals.check.platform): a subscription is created
 * disabled (a draft); enabling is an ACTIVATE proposal, deleting a DELETE proposal, and once approved every
 * edit is an UPDATE proposal. Disabling and rotating the signing secret (a revocation) are immediate.
 */
@Controller('v1')
export class WebhooksController {
  constructor(
    @Inject(WebhookService) private readonly webhooks: WebhookService,
    @Inject(WebhookDeliveryService) private readonly delivery: WebhookDeliveryService,
    @Inject(ApprovalService) private readonly approvals: ApprovalService,
  ) {}

  @Get('webhooks')
  @RequirePermission(Permission.WEBHOOKS_MANAGE)
  async list(@Actor() actor: ActorContext, @CurrentPrincipal() principal: Principal) {
    return withApprovalState(this.approvals, principal, 'webhook_subscription', await this.webhooks.list(actor));
  }

  @Get('webhooks/event-types')
  @RequirePermission(Permission.WEBHOOKS_MANAGE)
  eventTypes() {
    return WEBHOOK_EVENT_TYPES;
  }

  /** Returns the signing secret once; it is never readable again. A disabled draft; with `approval` its activation is submitted too (202). */
  @Post('webhooks')
  @RequirePermission(Permission.WEBHOOKS_MANAGE)
  create(@Actor() actor: ActorContext, @Body({ schema: CreateBody }) body: CreateBody, @Res({ passthrough: true }) res: Response) {
    const { approval, ...input } = body;
    return createDraft(res, { approvals: this.approvals, actor, kind: 'webhook_subscription', live: approval !== undefined, approval, create: () => this.webhooks.create(actor, input) });
  }

  /** `enabled: false` disables at once; `enabled: true` is an ACTIVATE proposal; other fields: draft direct (204), else UPDATE proposal (202). */
  @Patch('webhooks/:id')
  @HttpCode(204)
  @RequirePermission(Permission.WEBHOOKS_MANAGE)
  async update(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: PatchBody }) body: PatchBody, @Res({ passthrough: true }) res: Response) {
    const { approval, enabled, ...edit } = body;
    const hasEdit = Object.values(edit).some((v) => v !== undefined);
    if (enabled === false) await this.webhooks.disable(actor, id);
    if (enabled === true) {
      if (hasEdit) await this.webhooks.update(actor, id, edit);
      return proposeOnly(res, this.approvals, actor, { kind: 'webhook_subscription', id, action: 'ACTIVATE' }, approval);
    }
    if (!hasEdit) return undefined;
    return approvalResponse(res, requestApproval(this.approvals, actor, { objectKind: 'webhook_subscription', objectId: id, action: 'UPDATE', payload: edit }, approval, () => this.webhooks.update(actor, id, edit)));
  }

  @Post('webhooks/:id/rotate-secret')
  @RequirePermission(Permission.WEBHOOKS_MANAGE)
  rotate(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    return this.webhooks.rotateSecret(actor, id);
  }

  /** Always a proposal (DELETE): 202 `{proposal}` with `approval`, else 409 approval_required. */
  @Delete('webhooks/:id')
  @RequirePermission(Permission.WEBHOOKS_MANAGE)
  remove(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: OptionalApproval }) body: ApprovalBody, @Res({ passthrough: true }) res: Response) {
    return proposeOnly(res, this.approvals, actor, { kind: 'webhook_subscription', id, action: 'DELETE' }, body?.approval);
  }

  @Post('webhooks/:id/test')
  @RequirePermission(Permission.WEBHOOKS_MANAGE)
  async test(@Param('id', { schema: Id }) id: string) {
    await this.webhooks.get(id);
    return this.delivery.sendTest(id);
  }

  @Get('webhooks/:id/deliveries')
  @RequirePermission(Permission.WEBHOOKS_MANAGE)
  deliveries(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Query({ schema: DeliveriesQuery }) q: DeliveriesQuery) {
    return this.webhooks.deliveries(actor, id, q.status);
  }

  @Post('webhook-deliveries/:id/retry')
  @HttpCode(204)
  @RequirePermission(Permission.WEBHOOKS_MANAGE)
  async retry(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string): Promise<void> {
    await this.webhooks.retry(actor, id);
  }
}
