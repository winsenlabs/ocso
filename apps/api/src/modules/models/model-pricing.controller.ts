import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Res } from '@nestjs/common';
import { Permission, type Principal } from '@ocso/auth';
import { ApprovalService, CatalogPriceInput, PricingInput, PricingPatch, PricingService, WithApproval, requestApproval, type ActorContext } from '@ocso/application';
import type { Response } from 'express';
import { z } from 'zod';
import { Actor, CurrentPrincipal, RequirePermission } from '../../common/decorators.js';
import { approvalResponse } from '../approvals/approval-response.js';
import { createDraft, proposeOnly, withApprovalState, OptionalApproval, type ApprovalBody } from '../settings/platform-approvals.js';

const CreateBody = PricingInput.extend(WithApproval.shape);
type CreateBody = z.infer<typeof CreateBody>;
const PatchBody = PricingPatch.extend(WithApproval.shape);
type PatchBody = z.infer<typeof PatchBody>;

/**
 * Price table for usage cost metadata (micro-units per 1M tokens). Maker–checker (PM/research/11 §4): a price
 * a person adds is a draft that prices nothing until its ACTIVATE proposal is approved; a live row changes,
 * and any row is removed, only by proposal. Adding the catalog's price stays direct (system data).
 */
@Controller('v1/model-pricing')
export class ModelPricingController {
  constructor(
    @Inject(PricingService) private readonly pricing: PricingService,
    @Inject(ApprovalService) private readonly approvals: ApprovalService,
  ) {}

  @Get()
  @RequirePermission(Permission.PRICING_MANAGE)
  async list(@Actor() actor: ActorContext, @CurrentPrincipal() principal: Principal) {
    return withApprovalState(this.approvals, principal, 'model_pricing', await this.pricing.list(actor));
  }

  /** Models in use (profiles, last 30 days of usage) that no row prices, with the catalog's offer. */
  @Get('missing')
  @RequirePermission(Permission.PRICING_MANAGE)
  missing(@Actor() actor: ActorContext) {
    return this.pricing.missing(actor);
  }

  /** Add the model catalog's price for one model as a catalog-origin row. */
  @Post('from-catalog')
  @RequirePermission(Permission.PRICING_MANAGE)
  fromCatalog(@Actor() actor: ActorContext, @Body({ schema: CatalogPriceInput }) body: CatalogPriceInput) {
    return this.pricing.addFromCatalog(actor, body);
  }

  /** A draft row (201); with `approval` its activation is submitted too (202 `{…row, proposal}`). */
  @Post()
  @RequirePermission(Permission.PRICING_MANAGE)
  create(@Actor() actor: ActorContext, @Body({ schema: CreateBody }) body: CreateBody, @Res({ passthrough: true }) res: Response) {
    const { approval, ...input } = body;
    return createDraft(res, { approvals: this.approvals, actor, kind: 'model_pricing', live: approval !== undefined, approval, create: () => this.pricing.create(actor, input) });
  }

  @Patch(':id')
  @RequirePermission(Permission.PRICING_MANAGE)
  update(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: PatchBody }) body: PatchBody, @Res({ passthrough: true }) res: Response) {
    const { approval, ...patch } = body;
    return approvalResponse(res, requestApproval(this.approvals, actor, { objectKind: 'model_pricing', objectId: id, action: 'UPDATE', payload: patch }, approval, () => this.pricing.update(actor, id, patch)));
  }

  /** Make a draft price apply: always a proposal (ACTIVATE). */
  @Post(':id/activate')
  @HttpCode(202)
  @RequirePermission(Permission.PRICING_MANAGE)
  activate(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: OptionalApproval }) body: ApprovalBody, @Res({ passthrough: true }) res: Response) {
    return proposeOnly(res, this.approvals, actor, { kind: 'model_pricing', id, action: 'ACTIVATE' }, body?.approval);
  }

  /** Always a proposal (DELETE): 202 `{proposal}` with `approval`, else 409 approval_required. */
  @Delete(':id')
  @RequirePermission(Permission.PRICING_MANAGE)
  remove(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: OptionalApproval }) body: ApprovalBody, @Res({ passthrough: true }) res: Response) {
    return proposeOnly(res, this.approvals, actor, { kind: 'model_pricing', id, action: 'DELETE' }, body?.approval);
  }
}
