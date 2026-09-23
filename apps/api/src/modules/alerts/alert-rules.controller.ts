import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { AlertRuleInput, AlertRuleListQuery, AlertRulePatch, AlertRuleService, type ActorContext } from '@ocso/application';
import { z } from 'zod';
import { Actor, Authenticated } from '../../common/decorators.js';

/**
 * Alert rules. The required permission depends on the rule's kind
 * (alert_rules.technical.manage vs alert_rules.business.manage), so it is
 * enforced in AlertRuleService against the stored and requested kind.
 */
@Controller('v1/alert-rules')
export class AlertRulesController {
  constructor(@Inject(AlertRuleService) private readonly rules: AlertRuleService) {}

  @Get()
  @Authenticated()
  list(@Actor() actor: ActorContext, @Query({ schema: AlertRuleListQuery }) query: AlertRuleListQuery) {
    return this.rules.list(actor, query);
  }

  /** Evaluator catalogue: condition, kinds, method and params JSON schema. */
  @Get('conditions')
  @Authenticated()
  conditions(@Actor() actor: ActorContext) {
    return this.rules.conditions(actor);
  }

  @Get(':id')
  @Authenticated()
  get(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string) {
    return this.rules.get(actor, id);
  }

  @Post()
  @Authenticated()
  create(@Actor() actor: ActorContext, @Body({ schema: AlertRuleInput }) body: AlertRuleInput) {
    return this.rules.create(actor, body);
  }

  @Patch(':id')
  @Authenticated()
  update(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: AlertRulePatch }) body: AlertRulePatch) {
    return this.rules.update(actor, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @Authenticated()
  async remove(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string): Promise<void> {
    await this.rules.delete(actor, id);
  }
}
