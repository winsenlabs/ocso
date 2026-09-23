import { Body, Controller, Get, Inject, Patch, Res } from '@nestjs/common';
import { Permission, type Principal } from '@ocso/auth';
import {
  ApprovalService,
  DeploymentSettingsInput,
  SETTINGS_OBJECT_ID,
  ScalingStatusService,
  SettingsService,
  WithApproval,
  WorkerSettingsInput,
  describeRetention,
  requestApproval,
  sectionsOfDeploymentInput,
  type ActorContext,
  type ApprovalRequest,
  type SettingsChange,
} from '@ocso/application';
import type { Response } from 'express';
import type { z } from 'zod';
import { Actor, Authenticated, CurrentPrincipal, RequireAnyPermission, RequirePermission } from '../../common/decorators.js';
import { approvalResponse } from '../approvals/approval-response.js';

const DeploymentBody = DeploymentSettingsInput.extend(WithApproval.shape);
type DeploymentBody = z.infer<typeof DeploymentBody>;
const WorkersBody = WorkerSettingsInput.and(WithApproval);
type WorkersBody = z.infer<typeof WorkersBody>;

/**
 * Deployment and worker settings. Maker–checker (PM/research/11 §4, approvals.check.platform): settings are
 * always live, so every change is a proposal on the deployment-settings singleton — 202 `{proposal}` with
 * `approval`, else 409 approval_required. One settings proposal is open at a time.
 */
@Controller('v1/settings')
export class SettingsController {
  constructor(
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(ScalingStatusService) private readonly scaling: ScalingStatusService,
    @Inject(ApprovalService) private readonly approvals: ApprovalService,
  ) {}

  /** The settings proposal that is open (or activating), for the Settings screens' pending badge. */
  @Get('approval')
  @RequireAnyPermission(Permission.DEPLOYMENT_SETTINGS_MANAGE, Permission.SYSTEM_CONFIGURE)
  approval(@CurrentPrincipal() principal: Principal) {
    return this.approvals.objectState(principal, 'deployment_settings', SETTINGS_OBJECT_ID);
  }

  @Get('deployment')
  @Authenticated()
  deployment() {
    return this.settings.deployment();
  }

  /** Retention classes with defaults, floors and the effective values (docs/15 §8). */
  @Get('retention')
  @Authenticated()
  async retention() {
    return describeRetention((await this.settings.deployment()).retention);
  }

  @Patch('deployment')
  @RequirePermission(Permission.DEPLOYMENT_SETTINGS_MANAGE)
  updateDeployment(@Actor() actor: ActorContext, @Body({ schema: DeploymentBody }) body: DeploymentBody, @Res({ passthrough: true }) res: Response) {
    const { approval, ...input } = body;
    return this.propose(res, actor, sectionsOfDeploymentInput(input), approval);
  }

  /** Worker settings plus how far the deployment has applied them (ADR-023): applied / advisory / failed / pending. */
  @Get('workers')
  @RequirePermission(Permission.SYSTEM_READ)
  async workers() {
    const settings = await this.settings.workers();
    return { ...settings, scaling: await this.scaling.workers(undefined, settings) };
  }

  @Patch('workers')
  @RequirePermission(Permission.SYSTEM_CONFIGURE)
  updateWorkers(@Actor() actor: ActorContext, @Body({ schema: WorkersBody }) body: WorkersBody, @Res({ passthrough: true }) res: Response) {
    const { approval, ...workers } = body;
    return this.propose(res, actor, { workers }, approval);
  }

  private propose(res: Response, actor: ActorContext, change: SettingsChange, approval: ApprovalRequest | undefined) {
    return approvalResponse(res, requestApproval(this.approvals, actor, { objectKind: 'deployment_settings', objectId: SETTINGS_OBJECT_ID, action: 'UPDATE', payload: change as Record<string, unknown> }, approval, null));
  }

  /**
   * The worker service as the platform reports it (ECS desired/running/pending,
   * scalable target, policies, alarm), as last recorded by the worker leader —
   * the API itself holds no scaling permissions.
   */
  @Get('workers/deployment')
  @RequirePermission(Permission.SYSTEM_READ)
  workerDeployment() {
    return this.scaling.deployment();
  }
}
