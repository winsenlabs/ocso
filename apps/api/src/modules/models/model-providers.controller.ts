import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { Permission, type Principal } from '@ocso/auth';
import { ApprovalService, ModelListService, ProviderInput, ProviderPatch, ProviderService, ProviderTestInput, WithApproval, requestStagedApproval, type ActorContext } from '@ocso/application';
import type { Response } from 'express';
import { z } from 'zod';
import { Actor, CurrentPrincipal, RequirePermission } from '../../common/decorators.js';
import { approvalResponse } from '../approvals/approval-response.js';
import { createDraft, proposeOnly, withApprovalState, OptionalApproval, type ApprovalBody } from '../settings/platform-approvals.js';

const CreateBody = ProviderInput.extend(WithApproval.shape);
type CreateBody = z.infer<typeof CreateBody>;
const PatchBody = ProviderPatch.extend(WithApproval.shape);
type PatchBody = z.infer<typeof PatchBody>;

/** `?refresh=true` bypasses the ten-minute listing cache (providers.manage, checked in the service). */
const ModelsQuery = z.object({ refresh: z.stringbool().default(false) });
type ModelsQuery = z.infer<typeof ModelsQuery>;

/** A test may be sent without a body; it then probes the configured/default model. */
const TestBody = ProviderTestInput.optional();
type TestBody = z.infer<typeof TestBody>;

/**
 * Model providers (docs/06). Responses carry secret references, never credential values.
 * Maker–checker (PM/research/11 §4, approvals.check.platform): a provider is created disabled (a draft);
 * enabling is an ACTIVATE proposal, deleting a DELETE proposal, and once approved every edit is an UPDATE
 * proposal whose new credentials travel as secret refs. Disabling is immediate.
 */
@Controller('v1/model-providers')
export class ModelProvidersController {
  constructor(
    @Inject(ProviderService) private readonly providers: ProviderService,
    @Inject(ModelListService) private readonly models: ModelListService,
    @Inject(ApprovalService) private readonly approvals: ApprovalService,
  ) {}

  @Get()
  @RequirePermission(Permission.PROVIDERS_READ)
  async list(@Actor() actor: ActorContext, @CurrentPrincipal() principal: Principal) {
    return withApprovalState(this.approvals, principal, 'model_provider', await this.providers.list(actor));
  }

  /** Provider kinds available in this deployment, with form field descriptors. */
  @Get('kinds')
  @RequirePermission(Permission.PROVIDERS_READ)
  kinds(@Actor() actor: ActorContext) {
    return this.providers.kinds(actor);
  }

  @Get(':id')
  @RequirePermission(Permission.PROVIDERS_READ)
  async get(@Actor() actor: ActorContext, @CurrentPrincipal() principal: Principal, @Param('id', { schema: z.uuid() }) id: string) {
    return (await withApprovalState(this.approvals, principal, 'model_provider', [await this.providers.get(actor, id)]))[0];
  }

  /**
   * Models this provider offers (its own listing, or its configured deployments),
   * with catalog metadata and prices. Listing failures come back as `error`.
   */
  @Get(':id/models')
  @RequirePermission(Permission.PROVIDERS_READ)
  listModels(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string, @Query({ schema: ModelsQuery }) q: ModelsQuery) {
    return this.models.list(actor, id, { refresh: q.refresh });
  }

  /** A disabled draft (201); `enabled: true` with `approval` also submits its activation (202). */
  @Post()
  @RequirePermission(Permission.PROVIDERS_MANAGE)
  create(@Actor() actor: ActorContext, @Body({ schema: CreateBody }) body: CreateBody, @Res({ passthrough: true }) res: Response) {
    const { approval, ...input } = body;
    return createDraft(res, { approvals: this.approvals, actor, kind: 'model_provider', live: input.enabled, approval, create: () => this.providers.create(actor, input) });
  }

  /**
   * `enabled: false` disables at once (never gated); `enabled: true` is an ACTIVATE proposal (a draft's other
   * fields are saved first). Other fields: written directly on a draft, an UPDATE proposal once approved.
   */
  @Patch(':id')
  @RequirePermission(Permission.PROVIDERS_MANAGE)
  async update(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: PatchBody }) body: PatchBody, @Res({ passthrough: true }) res: Response) {
    const { approval, enabled, ...edit } = body;
    const hasEdit = Object.values(edit).some((v) => v !== undefined);
    if (enabled === false) await this.providers.setEnabled(actor, id, false);
    if (enabled === true) {
      if (hasEdit) await this.providers.update(actor, id, edit);
      return proposeOnly(res, this.approvals, actor, { kind: 'model_provider', id, action: 'ACTIVATE' }, approval);
    }
    if (!hasEdit) return this.providers.get(actor, id);
    return approvalResponse(
      res,
      requestStagedApproval(this.approvals, actor, { objectKind: 'model_provider', objectId: id, action: 'UPDATE' }, approval, () => this.providers.update(actor, id, edit), () => this.providers.stageChange(actor, id, edit)),
    );
  }

  /** "Test connection": health probe plus a tiny generation; updates the provider's health fields. */
  @Post(':id/test')
  @HttpCode(200)
  @RequirePermission(Permission.PROVIDERS_MANAGE)
  test(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: TestBody }) body: TestBody) {
    return this.providers.test(actor, id, body ?? {});
  }

  /** Always a proposal (DELETE): 202 `{proposal}` with `approval`, else 409 approval_required. */
  @Delete(':id')
  @RequirePermission(Permission.PROVIDERS_MANAGE)
  remove(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: OptionalApproval }) body: ApprovalBody, @Res({ passthrough: true }) res: Response) {
    return proposeOnly(res, this.approvals, actor, { kind: 'model_provider', id, action: 'DELETE' }, body?.approval);
  }
}
