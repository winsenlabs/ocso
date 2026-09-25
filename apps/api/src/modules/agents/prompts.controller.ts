import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query, Res } from '@nestjs/common';
import { Permission, type Principal } from '@ocso/auth';
import {
  AgentService,
  ApprovalService,
  ComponentsInput,
  CreateVersionInput,
  PromptService,
  WithApproval,
  requestApproval,
  type ActorContext,
} from '@ocso/application';
import type { Response } from 'express';
import { channelContextFrom, loadAgentToolCatalog } from '@ocso/agent-runtime';
import type { ChannelRegistry } from '@ocso/channels';
import { channels, users, type Db } from '@ocso/db';
import { notFound } from '@ocso/domain';
import { COMPONENT_DESCRIPTORS, compilePrompt, estimateTokens, type PromptComponents } from '@ocso/prompt-compiler';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { Actor, Capability, CurrentPrincipal, RequirePermission } from '../../common/decorators.js';
import { CHANNEL_REGISTRY, DB } from '../../infrastructure/tokens.js';
import { approvalResponse } from '../approvals/approval-response.js';

const Id = z.uuid();
const DiffQuery = z.object({ from: z.uuid(), to: z.uuid() });
const PreviewQuery = z.object({ channelId: z.uuid().optional() });
type PreviewQuery = z.infer<typeof PreviewQuery>;
type DiffQuery = z.infer<typeof DiffQuery>;
type Components = z.infer<typeof ComponentsInput>;
type ApprovalBody = z.infer<typeof WithApproval>;

/**
 * Structured prompt editing and versioning (design/02 Prompt/Versions tabs;
 * escalation rules: escalation-rules.controller.ts). The services scope every call to agents
 * the caller can read (reads) or whose owning team they are in (writes); 404
 * otherwise (ADR-026).
 */
@Controller('v1/agents/:agentId')
export class PromptsController {
  constructor(
    @Inject(PromptService) private readonly prompts: PromptService,
    @Inject(AgentService) private readonly agents: AgentService,
    @Inject(DB) private readonly db: Db,
    @Inject(CHANNEL_REGISTRY) private readonly registry: ChannelRegistry,
    @Inject(ApprovalService) private readonly approvals: ApprovalService,
  ) {}

  @Capability({ name: 'agents.get_agent_prompt', summary: "Get a virtual agent's prompt: the draft, the active version and the version history.", tags: ['prompt', 'instructions'] })
  @Get('prompt')
  @RequirePermission(Permission.AGENTS_READ)
  async prompt(@CurrentPrincipal() principal: Principal, @Param('agentId', { schema: Id }) agentId: string) {
    const [draft, versions] = await Promise.all([this.prompts.draft(principal, agentId), this.prompts.versions(principal, agentId)]);
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
      // Attribution for the version list (docs/archive/specs/05 §2: author); names only, readable with agents.read.
      versions: versions.map((v) => ({ ...v, authorName: v.authorId ? (authorName.get(v.authorId) ?? null) : null })),
    };
  }

  /**
   * Compiled preview with a synthetic customer turn: token estimates and hashes
   * per layer. The channel block is one of the agent's own channels
   * (`?channelId=`, default the first attached); none when it has no channel.
   */
  @Capability({ name: 'agents.preview_agent_prompt', summary: "Preview a virtual agent's compiled prompt for a channel, with token estimates per layer.", tags: ['prompt'] })
  @Get('prompt/preview')
  @RequirePermission(Permission.AGENTS_READ)
  async preview(@CurrentPrincipal() principal: Principal, @Param('agentId', { schema: Id }) agentId: string, @Query({ schema: PreviewQuery }) q: PreviewQuery) {
    const [agent, draft] = await Promise.all([this.agents.get(principal, agentId), this.prompts.draft(principal, agentId)]);
    const channelId = q.channelId ?? agent.channelIds[0];
    if (q.channelId && !agent.channelIds.includes(q.channelId)) throw notFound('channel', q.channelId);
    const [channel] = channelId ? await this.db.select().from(channels).where(eq(channels.id, channelId)) : [];
    const compiled = compilePrompt({
      agent: { id: agent.id, name: agent.name, conversationType: agent.conversationType },
      promptVersion: { id: 'draft', version: 0, components: draft.components },
      // The agent's real tool definitions, so the prefix hash matches what turns send.
      tools: (await loadAgentToolCatalog(this.db, agentId)).specs,
      channel: channel ? channelContextFrom(this.registry)(channel) : null,
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

  @Capability({ name: 'agents.save_prompt_draft', summary: "Edit a virtual agent's prompt draft (identity, objective, behavior, policies, escalation…).", tags: ['prompt', 'instructions', 'edit'] })
  @Put('prompt/draft')
  @HttpCode(204)
  @RequirePermission(Permission.PROMPTS_EDIT)
  async saveDraft(@Actor() actor: ActorContext, @Param('agentId', { schema: Id }) agentId: string, @Body({ schema: ComponentsInput }) body: Components) {
    await this.prompts.saveDraft(actor, agentId, body);
  }

  @Capability({ name: 'agents.discard_prompt_draft', summary: "Throw away a virtual agent's prompt draft.", tags: ['prompt'] })
  @Delete('prompt/draft')
  @HttpCode(204)
  @RequirePermission(Permission.PROMPTS_EDIT)
  async discardDraft(@Actor() actor: ActorContext, @Param('agentId', { schema: Id }) agentId: string) {
    await this.prompts.discardDraft(actor, agentId);
  }

  @Capability({ name: 'agents.create_prompt_version', summary: "Freeze a virtual agent's prompt draft into a new version, with a reason.", tags: ['prompt', 'version'] })
  @Post('prompt/versions')
  @RequirePermission(Permission.PROMPTS_EDIT)
  createVersion(@Actor() actor: ActorContext, @Param('agentId', { schema: Id }) agentId: string, @Body({ schema: CreateVersionInput }) body: CreateVersionInput) {
    return this.prompts.createVersionFromDraft(actor, agentId, body);
  }

  /**
   * A draft agent's prompt activates directly (204). Once the agent has been
   * approved, activation is a proposal (kind prompt_version): 202 `{proposal}`
   * with `approval`, else 409 approval_required.
   */
  @Capability({ name: 'agents.activate_prompt_version', summary: "Make a prompt version the virtual agent's active prompt (needs approval once the agent is approved).", tags: ['prompt', 'version', 'publish'] })
  @Post('prompt/versions/:versionId/activate')
  @HttpCode(204)
  @RequirePermission(Permission.PROMPTS_ACTIVATE)
  async activate(
    @Actor() actor: ActorContext,
    @Param('agentId', { schema: Id }) agentId: string,
    @Param('versionId', { schema: Id }) versionId: string,
    @Body({ schema: WithApproval.optional() }) body: ApprovalBody | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.prompts.assertVersionOf(actor, agentId, versionId);
    const outcome = await approvalResponse(res, requestApproval(this.approvals, actor, { objectKind: 'prompt_version', objectId: versionId, action: 'ACTIVATE' }, body?.approval, () => this.prompts.activate(actor, agentId, versionId)));
    return outcome ?? undefined;
  }

  @Capability({ name: 'agents.diff_prompt_versions', summary: "Compare two versions of a virtual agent's prompt.", tags: ['prompt', 'version', 'compare'] })
  @Get('prompt/diff')
  @RequirePermission(Permission.AGENTS_READ)
  diff(@CurrentPrincipal() principal: Principal, @Param('agentId', { schema: Id }) agentId: string, @Query({ schema: DiffQuery }) q: DiffQuery) {
    return this.prompts.diff(principal, agentId, q.from, q.to);
  }
}
