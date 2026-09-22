import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { Permission } from '@ocso/auth';
import {
  AgentService,
  ComponentsInput,
  CreateVersionInput,
  EscalationRuleInput,
  EscalationRuleService,
  PromptService,
  type ActorContext,
} from '@ocso/application';
import { users, type Db } from '@ocso/db';
import { COMPONENT_DESCRIPTORS, compilePrompt, estimateTokens, type PromptComponents } from '@ocso/prompt-compiler';
import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import { Actor, RequirePermission } from '../../common/decorators.js';
import { DB } from '../../infrastructure/tokens.js';

const Id = z.uuid();
const DiffQuery = z.object({ from: z.uuid(), to: z.uuid() });
type DiffQuery = z.infer<typeof DiffQuery>;
type Components = z.infer<typeof ComponentsInput>;
const RulePatch = EscalationRuleInput.partial();
type RulePatch = z.infer<typeof RulePatch>;

/** Structured prompt editing, versioning and escalation rules (design/02 Prompt/Versions/Escalation tabs). */
@Controller('v1/agents/:agentId')
export class PromptsController {
  constructor(
    @Inject(PromptService) private readonly prompts: PromptService,
    @Inject(AgentService) private readonly agents: AgentService,
    @Inject(EscalationRuleService) private readonly rules: EscalationRuleService,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Get('prompt')
  @RequirePermission(Permission.AGENTS_READ)
  async prompt(@Param('agentId', { schema: Id }) agentId: string) {
    const [draft, versions] = await Promise.all([this.prompts.draft(agentId), this.prompts.versions(agentId)]);
    const authorIds = [...new Set(versions.flatMap((v) => (v.authorId ? [v.authorId] : [])))];
    const authors = authorIds.length ? await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, authorIds)) : [];
    const authorName = new Map(authors.map((a) => [a.id, a.name]));
    return {
      components: COMPONENT_DESCRIPTORS.map((d) => ({
        ...d,
        text: d.key === 'runtime_contract' ? null : (draft.components[d.key as keyof PromptComponents] ?? ''),
        tokens: d.key === 'runtime_contract' ? null : estimateTokens(draft.components[d.key as keyof PromptComponents] ?? ''),
      })),
      dirty: draft.dirty,
      baseVersionId: draft.baseVersionId,
      // Attribution for the version list (docs/05 §2: author); names only, readable with agents.read.
      versions: versions.map((v) => ({ ...v, authorName: v.authorId ? (authorName.get(v.authorId) ?? null) : null })),
    };
  }

  /** Compiled preview with a synthetic customer turn: token estimates and hashes per layer. */
  @Get('prompt/preview')
  @RequirePermission(Permission.AGENTS_READ)
  async preview(@Param('agentId', { schema: Id }) agentId: string) {
    const [agent, draft] = await Promise.all([this.agents.get(agentId), this.prompts.draft(agentId)]);
    const compiled = compilePrompt({
      agent: { id: agent.id, name: agent.name, conversationType: agent.conversationType },
      promptVersion: { id: 'draft', version: 0, components: draft.components },
      tools: [],
      channel: { kind: 'WHATSAPP', label: 'WhatsApp' },
      customer: null,
      summary: null,
      handover: null,
      recent: [],
      current: [{ seq: 1, actorType: 'CUSTOMER', parts: [{ type: 'TEXT', text: '(example customer message)' }] }],
      capabilities: { imageInput: true, fileInput: true, audioInput: false },
      today: new Date().toISOString().slice(0, 10),
    });
    return { system: compiled.system, tokenEstimate: compiled.tokenEstimate, hashes: compiled.hashes };
  }

  @Put('prompt/draft')
  @HttpCode(204)
  @RequirePermission(Permission.PROMPTS_EDIT)
  async saveDraft(@Actor() actor: ActorContext, @Param('agentId', { schema: Id }) agentId: string, @Body({ schema: ComponentsInput }) body: Components) {
    await this.prompts.saveDraft(actor, agentId, body);
  }

  @Delete('prompt/draft')
  @HttpCode(204)
  @RequirePermission(Permission.PROMPTS_EDIT)
  async discardDraft(@Actor() actor: ActorContext, @Param('agentId', { schema: Id }) agentId: string) {
    await this.prompts.discardDraft(actor, agentId);
  }

  @Post('prompt/versions')
  @RequirePermission(Permission.PROMPTS_EDIT)
  createVersion(@Actor() actor: ActorContext, @Param('agentId', { schema: Id }) agentId: string, @Body({ schema: CreateVersionInput }) body: CreateVersionInput) {
    return this.prompts.createVersionFromDraft(actor, agentId, body);
  }

  @Post('prompt/versions/:versionId/activate')
  @HttpCode(204)
  @RequirePermission(Permission.PROMPTS_ACTIVATE)
  async activate(@Actor() actor: ActorContext, @Param('agentId', { schema: Id }) agentId: string, @Param('versionId', { schema: Id }) versionId: string) {
    await this.prompts.activate(actor, agentId, versionId);
  }

  @Get('prompt/diff')
  @RequirePermission(Permission.AGENTS_READ)
  diff(@Param('agentId', { schema: Id }) agentId: string, @Query({ schema: DiffQuery }) q: DiffQuery) {
    return this.prompts.diff(agentId, q.from, q.to);
  }

  @Get('escalation-rules')
  @RequirePermission(Permission.AGENTS_READ)
  listRules(@Param('agentId', { schema: Id }) agentId: string) {
    return this.rules.list(agentId);
  }

  @Post('escalation-rules')
  @RequirePermission(Permission.ESCALATION_MANAGE)
  createRule(@Actor() actor: ActorContext, @Param('agentId', { schema: Id }) agentId: string, @Body({ schema: EscalationRuleInput }) body: EscalationRuleInput) {
    return this.rules.create(actor, agentId, body);
  }

  @Put('escalation-rules/:ruleId')
  @RequirePermission(Permission.ESCALATION_MANAGE)
  updateRule(@Actor() actor: ActorContext, @Param('ruleId', { schema: Id }) ruleId: string, @Body({ schema: RulePatch }) body: RulePatch) {
    return this.rules.update(actor, ruleId, body);
  }

  @Delete('escalation-rules/:ruleId')
  @HttpCode(204)
  @RequirePermission(Permission.ESCALATION_MANAGE)
  async deleteRule(@Actor() actor: ActorContext, @Param('ruleId', { schema: Id }) ruleId: string) {
    await this.rules.remove(actor, ruleId);
  }
}
