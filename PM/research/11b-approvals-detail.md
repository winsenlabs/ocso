# 11b — Approval spine: detailed design

Companion to `11-governance-and-routing.md`, which wins where the two differ (notably: submission via `approval` on
write endpoints returning 202/409, the BOOTSTRAP_APPROVE decision, user/permission_change kinds, Head presets for the
five check permissions, grandfather migration numbered 0027 after routing). Check-permission defaults below reflect the
main document: HEAD holds all five, TECH holds platform + permissions + reassign_any.

Two tables. `approval_proposals` holds one proposal (object kind + id, action, payload, before/after snapshots, content hash, maker, named checker, reason). `approval_decisions` is the append-only history of every submit/edit/approve/reject/reassign/block, trigger-protected like `audit_events`.

Each approvable kind registers an `ApprovalDescriptor` (kind, label, actions, makePermission, checkPermission, project/projectAfter/teamIds/dependencies/validate/activate). Core never switches on a kind — the ADR-028 shape, but inside packages/application because these are domain objects, not plugins.

Governing rule: an object that has never been approved is inert and freely editable by whoever may manage it; the FIRST approval is what makes it live, and from then on every change to it is a proposal. "Approved" is DERIVED from the proposal table, not a new column on 13 tables — channels.default_agent_id already proved what duplicated state costs. Existing live config is grandfathered by migration 0022 (one origin='MIGRATION' APPROVED proposal per live object).

Approve and activate share one transaction, so there is no stale-approval window. Kinds whose activation must leave the transaction (template submitted to a provider, MCP connection enabled) return DEFERRED and are finished by a worker consumer that re-runs validate and re-checks the content hash before touching the provider — that is "re-validate at activation, not only at approval".

While a proposal is open the object itself is locked for approvable writes (409 approval_open); the maker edits the PROPOSAL, which bumps its revision. Stopping is exempt: pause/disable/revoke bypass the guard entirely; setStatus('LIVE') is action ACTIVATE and always goes through it.

## dataModel
Two new tables in the MAIN database; one new settings column. NO columns on the 13 approvable tables.

**packages/db/src/schema/approvals.ts**

```
approval_proposals
  id                       uuid PK              -- uuidv7()
  object_kind              text NOT NULL        -- descriptor kind: 'agent','prompt_version','message_template','router','routing_rule','queue','escalation_rule','model_profile','model_provider','channel','mcp_connection','agent_tool_grant','permission_change','deployment_settings'
  object_id                uuid NOT NULL        -- no FK: kinds live in different tables (audit_events precedent)
  action                   text NOT NULL        -- CREATE | UPDATE | DELETE | ACTIVATE
  status                   text NOT NULL DEFAULT 'SUBMITTED'  -- SUBMITTED|APPROVED|REJECTED|WITHDRAWN|BLOCKED|VOID
  origin                   text NOT NULL DEFAULT 'USER'       -- USER | MIGRATION
  revision                 integer NOT NULL DEFAULT 1
  payload                  jsonb NOT NULL DEFAULT '{}'        -- validated input to apply; NEVER returned over HTTP
  before_snapshot          jsonb                              -- descriptor.project() at submit, sanitizeForAudit'd
  after_snapshot           jsonb                              -- descriptor.projectAfter(); null for DELETE
  content_hash             text NOT NULL        -- contentHash({object_kind,object_id,action,revision,payload,before_snapshot},'ap')
  dependency_keys          text[] NOT NULL DEFAULT '{}'       -- ['model_profile:<id>','queue:<id>']
  dependency_hash          text NOT NULL        -- contentHash(sorted 'kind:id@updated_at' strings,'ad')
  team_ids                 uuid[] NOT NULL DEFAULT '{}'       -- owning teams at submit; '{}' = platform-wide
  title                    text NOT NULL        -- "Take Maya live" — queue row + email subject
  reason                   text NOT NULL        -- maker's reason, >= 3 chars
  maker_id                 uuid REFERENCES users(id)          -- null only for origin='MIGRATION'
  checker_id               uuid REFERENCES users(id)
  checker_valid            boolean NOT NULL DEFAULT true
  edited_after_submission  boolean NOT NULL DEFAULT false
  warnings                 jsonb NOT NULL DEFAULT '[]'        -- last evaluation snapshot (display/exception report)
  submitted_at             timestamptz NOT NULL DEFAULT now()
  notified_at              timestamptz                        -- checker notified; null + aged => redispatch
  decided_at               timestamptz
  decided_by               uuid REFERENCES users(id)
  decision_reason          text
  activated_at             timestamptz
  activation_attempts      integer NOT NULL DEFAULT 0
  blocked_reason           text
  created_at, updated_at   timestamptz NOT NULL DEFAULT now()

CHECK approval_proposals_action_ck   action IN ('CREATE','UPDATE','DELETE','ACTIVATE')
CHECK approval_proposals_status_ck   status IN ('SUBMITTED','APPROVED','REJECTED','WITHDRAWN','BLOCKED','VOID')
CHECK approval_proposals_self_ck     maker_id IS NULL OR checker_id IS NULL OR maker_id <> checker_id
CHECK approval_proposals_open_ck     status <> 'SUBMITTED' OR (maker_id IS NOT NULL AND checker_id IS NOT NULL)

UNIQUE approval_proposals_open_uq    (object_kind, object_id) WHERE status = 'SUBMITTED'   -- ONE approval per object
INDEX  approval_proposals_checker_idx (checker_id, status, submitted_at)
INDEX  approval_proposals_maker_idx   (maker_id, submitted_at DESC)
INDEX  approval_proposals_open_idx    (submitted_at) WHERE status = 'SUBMITTED'
INDEX  approval_proposals_object_idx  (object_kind, object_id, submitted_at DESC)
INDEX  approval_proposals_page_idx    (submitted_at DESC, id DESC)      -- keyset paging
INDEX  approval_proposals_teams_idx   USING gin (team_ids)
INDEX  approval_proposals_activate_idx (status) WHERE status='APPROVED' AND activated_at IS NULL
```

```
approval_decisions            -- append-only; the decision record survives an audit-store move
  id             uuid PK (uuidv7)
  proposal_id    uuid NOT NULL REFERENCES approval_proposals(id) ON DELETE CASCADE
  revision       integer NOT NULL                 -- the revision this decision applied to
  kind           text NOT NULL                    -- SUBMIT|EDIT|APPROVE|REJECT|WITHDRAW|REASSIGN|BLOCK|VOID|ACTIVATE
  actor_id       uuid REFERENCES users(id)
  actor_name     text NOT NULL
  reason         text
  content_hash   text NOT NULL                    -- exactly what the actor saw
  diff           jsonb NOT NULL DEFAULT '[]'      -- DiffField[] frozen at that moment
  warnings       jsonb NOT NULL DEFAULT '[]'
  bulk_batch_id  uuid                             -- set for every item of one bulk approve
  audit_event_id uuid
  occurred_at    timestamptz NOT NULL DEFAULT now()

CHECK  approval_decisions_kind_ck  kind IN (…)
INDEX  approval_decisions_proposal_idx (proposal_id, occurred_at)
INDEX  approval_decisions_kind_idx     (kind, occurred_at DESC)   -- exception report
INDEX  approval_decisions_bulk_idx     (bulk_batch_id) WHERE bulk_batch_id IS NOT NULL
TRIGGER approval_decisions_immutable BEFORE UPDATE OR DELETE FOR EACH ROW EXECUTE ocso_reject_decision_mutation()
TRIGGER approval_decisions_no_truncate BEFORE TRUNCATE FOR EACH STATEMENT EXECUTE ocso_reject_decision_mutation()
```

**deployment_settings** gains `approval_age_warning_hours integer NOT NULL DEFAULT 72` (shared with the exception-report area; also drives the `aged` warning).

Derived state, no denormalization:
- approved(kind,id) = EXISTS(… status='APPROVED' …)
- pending(kind,id)  = the row matching approval_proposals_open_uq
- display status ACTIVATING = status='APPROVED' AND activated_at IS NULL

## contracts
**packages/domain/src/approvals/state.ts** (pure, browser-safe; @ocso/domain imports nothing)
```ts
export const APPROVAL_STATUSES = ['SUBMITTED','APPROVED','REJECTED','WITHDRAWN','BLOCKED','VOID'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export const APPROVAL_ACTIONS = ['CREATE','UPDATE','DELETE','ACTIVATE'] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];
export const APPROVAL_DECISION_KINDS = ['SUBMIT','EDIT','APPROVE','REJECT','WITHDRAW','REASSIGN','BLOCK','VOID','ACTIVATE'] as const;
export type ApprovalDecisionKind = (typeof APPROVAL_DECISION_KINDS)[number];
/** Closed transition table, in the spirit of conversation/transitions.ts. Throws InvalidApprovalTransitionError. */
export function approvalTransition(from: ApprovalStatus, event: ApprovalDecisionKind): ApprovalStatus;
export function isOpen(status: ApprovalStatus): boolean;   // SUBMITTED only
export type ApprovalWarningCode =
  | 'content_changed' | 'dependency_changed' | 'edited_after_submission'
  | 'validation_failed' | 'checker_invalid' | 'self_review' | 'object_missing' | 'aged';
export interface ApprovalWarning { code: ApprovalWarningCode; message: string; blocksBulk: boolean }
export const BULK_BLOCKING: ReadonlySet<ApprovalWarningCode>;   // everything except 'aged'
```

**packages/domain/src/approvals/diff.ts** (pure; the API stores it, the web renders it — one implementation)
```ts
export interface DiffField { path: string; before: unknown; after: unknown; change: 'added'|'removed'|'changed' }
/** Dotted paths, depth cap 6, 200 fields, arrays compared whole. Deterministic key order. */
export function diffFields(before: unknown, after: unknown): DiffField[];
export function describeDiff(fields: readonly DiffField[]): string;  // "name, business hours, model profile"
```

**packages/application/src/approvals/contract.ts**
```ts
export type ApprovalActivation = { kind: 'DONE' } | { kind: 'DEFERRED' };
export interface ApprovalProblem { code: string; message: string }
export type ProposalRow = typeof approvalProposals.$inferSelect;

export interface ApprovalDescriptor {
  readonly kind: string;                              // 'agent' — also the audit target_type
  readonly label: string;                             // 'Virtual agent'
  readonly actions: readonly ApprovalAction[];
  readonly makePermission: Permission;                // same permission that guards the object's write route
  readonly checkPermission: Permission;               // one of APPROVAL_CHECK_PERMISSIONS
  readonly payload?: z.ZodType | undefined;           // CREATE/UPDATE only
  /** Checker-visible projection of the live object; null when it is gone. */
  project(tx: DbOrTx, objectId: string): Promise<Record<string, unknown> | null>;
  /** The same projection with the proposal applied; null for DELETE. */
  projectAfter(tx: DbOrTx, proposal: ProposalRow): Promise<Record<string, unknown> | null>;
  /** Owning teams at submit; [] = platform-wide. */
  teamIds(tx: DbOrTx, objectId: string): Promise<string[]>;
  /** 'kind:id@<updated_at ISO>' for everything whose change invalidates the proposal. */
  dependencies(tx: DbOrTx, proposal: ProposalRow): Promise<string[]>;
  /** ADR-026 visibility; throws notFound/forbidden exactly as the object's own service does. */
  assertVisible(tx: DbOrTx, principal: Principal, objectId: string): Promise<void>;
  /** Business validation. Runs at submit, at render, and again inside the activation transaction. */
  validate(tx: DbOrTx, proposal: ProposalRow): Promise<readonly ApprovalProblem[]>;
  /** Applies the change. MUST write the object's own recordAudit row and bump its cache generation. */
  activate(tx: DbOrTx, actor: ActorContext, proposal: ProposalRow): Promise<ApprovalActivation>;
  /** Only when activate returns DEFERRED. Runs in the worker, outside any transaction (provider calls). */
  activateDeferred?(db: Db, actor: ActorContext, proposal: ProposalRow): Promise<void>;
  title(proposal: ProposalRow, before: Record<string, unknown> | null): string;
}
```

**packages/application/src/approvals/registry.ts**
```ts
export class ApprovalRegistry {
  register(d: ApprovalDescriptor): void;      // rejects duplicate kind, and a checkPermission outside APPROVAL_CHECK_PERMISSIONS
  get(kind: string): ApprovalDescriptor;      // notFound('approval_kind', kind)
  has(kind: string): boolean;
  kinds(): readonly string[];
  makePermissions(): readonly Permission[];
}
export const APPROVAL_DESCRIPTORS: ApprovalRegistry;   // built in approvals/descriptors/index.ts
```

**Inputs** (packages/application/src/approvals/inputs.ts, zod 4, `patchOf` for the patch)
```ts
export const ApprovalSubmitInput = z.object({
  objectKind: z.string().trim().min(1).max(60),
  objectId: z.uuid(),
  action: z.enum(APPROVAL_ACTIONS),
  checkerId: z.uuid(),
  reason: z.string().trim().min(3).max(500),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export const ApprovalEditInput = patchOf(ApprovalSubmitInput).pick({ checkerId: true, reason: true, payload: true });
export const ApprovalDecisionInput = z.object({
  decision: z.enum(['APPROVE','REJECT']),
  reason: z.string().trim().min(3).max(500),
  contentHash: z.string().min(8).max(64),      // what the checker was shown; mismatch => 409 content_changed
});
export const BulkDecisionInput = z.object({
  decision: z.literal('APPROVE'),
  reason: z.string().trim().min(3).max(500),
  items: z.array(z.object({ id: z.uuid(), contentHash: z.string().min(8).max(64) })).min(1).max(50),
});
export const ReassignInput = z.object({ checkerId: z.uuid(), reason: z.string().trim().min(3).max(500) });
export const ApprovalQuery = z.object({
  box: z.enum(['AWAITING_ME','SENT_BY_ME','OPEN','DECIDED']).default('AWAITING_ME'),
  objectKind: z.string().max(60).optional(), status: z.enum(APPROVAL_STATUSES).optional(),
  makerId: z.uuid().optional(), checkerId: z.uuid().optional(),
  before: z.iso.datetime().optional(), beforeId: z.uuid().optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
```

**Services**
```ts
// packages/application/src/approvals/proposals.ts
export class ApprovalService {
  constructor(db: Db, registry: ApprovalRegistry, deps?: { now?: () => Date });
  submit(actor: ActorContext, input: ApprovalSubmitInput): Promise<ProposalDetail>;
  edit(actor: ActorContext, id: string, input: ApprovalEditInput): Promise<ProposalDetail>;
  withdraw(actor: ActorContext, id: string, reason: string): Promise<void>;
  list(principal: Principal, q: ApprovalQuery): Promise<{ rows: ProposalListItem[]; next: { before: string; beforeId: string } | null }>;
  get(principal: Principal, id: string): Promise<ProposalDetail>;
  counts(principal: Principal): Promise<{ awaitingMe: number; sentByMe: number; open: number; needsChecker: number }>;
  checkerCandidates(principal: Principal, objectKind: string, objectId: string): Promise<UserView[]>;
}
// packages/application/src/approvals/decisions.ts
export class ApprovalDecisionService {
  decide(actor: ActorContext, id: string, input: ApprovalDecisionInput): Promise<ProposalDetail>;
  bulkDecide(actor: ActorContext, input: BulkDecisionInput): Promise<BulkDecisionResult>;
  reassign(actor: ActorContext, id: string, input: ReassignInput): Promise<ProposalDetail>;
  /** Worker: finishes a DEFERRED activation. Re-validates and re-checks both hashes first. */
  finishActivation(actor: ActorContext, proposalId: string): Promise<'ACTIVATED' | 'BLOCKED' | 'SKIPPED'>;
}
export interface BulkDecisionResult { batchId: string; approved: string[]; skipped: Array<{ id: string; code: ApprovalWarningCode | 'not_open'; message: string }> }
// packages/application/src/approvals/guard.ts — what every approvable service calls
export async function assertChangeAllowed(tx: DbOrTx, kind: string, objectId: string): Promise<void>;  // 409 approval_open | 409 approval_required
export async function isApproved(tx: DbOrTx, kind: string, objectId: string): Promise<boolean>;
export async function openProposals(tx: DbOrTx, kind: string, ids: readonly string[]): Promise<Map<string, ProposalRef>>;
// packages/application/src/approvals/access.ts
export function approvalScope(principal: Principal): SQL | null;   // null = unrestricted (approvals.reassign_any)
export function mayCheck(principal: Principal, d: ApprovalDescriptor, p: ProposalRow): boolean;
// packages/application/src/approvals/warnings.ts
export async function evaluateWarnings(tx: DbOrTx, d: ApprovalDescriptor, p: ProposalRow, viewer: Principal | null): Promise<ApprovalWarning[]>;
```

**View shapes returned over HTTP** (`payload` is never included)
```ts
export interface ProposalListItem {
  id: string; objectKind: string; objectLabel: string; objectId: string; action: ApprovalAction;
  status: ApprovalStatus; activating: boolean; title: string; reason: string; revision: number;
  maker: { id: string; name: string }; checker: { id: string; name: string } | null; checkerValid: boolean;
  submittedAt: string; decidedAt: string | null; ageSeconds: number;
  warnings: ApprovalWarning[]; contentHash: string; changedFields: string[];
}
export interface ProposalDetail extends ProposalListItem {
  diff: DiffField[]; before: Record<string, unknown> | null; after: Record<string, unknown> | null;
  problems: ApprovalProblem[]; decisions: DecisionRow[]; canDecide: boolean; canEdit: boolean; canReassign: boolean;
}
```

**packages/email/src/templates/approval.ts** — `approvalEmail(input: ApprovalEmailInput): RenderedEmail` over the existing `renderLayout` (blocks: text, facts, button "Open in OCSO", note).

## api
All under `apps/api/src/modules/approvals/` (`ApprovalsModule` added to `FEATURE_MODULES` in apps/api/src/app.module.ts). No new `@Public()` route, so `PUBLIC_ROUTES` in apps/api/test/unit/route-access.test.ts is unchanged. `APPROVAL_CHECK_PERMISSIONS` / `APPROVAL_MAKE_PERMISSIONS` are exported const arrays from `@ocso/auth` so the decorators stay kind-agnostic.

| Method + path | Access rule | Body / query | Returns |
|---|---|---|---|
| `GET /v1/approvals` | `@RequirePermission(APPROVALS_READ)` | `ApprovalQuery` | `{ rows: ProposalListItem[], next }` — keyset `(submitted_at,id) < (before,beforeId)`, scoped by `approvalScope` |
| `GET /v1/approvals/counts` | `@RequirePermission(APPROVALS_READ)` | — | `{ awaitingMe, sentByMe, open, needsChecker }` |
| `GET /v1/approvals/kinds` | `@RequirePermission(APPROVALS_READ)` | — | `[{ kind, label, actions, checkPermission }]` from the registry (drives the UI filter chips) |
| `GET /v1/approvals/checkers` | `@RequirePermission(APPROVALS_READ)` | `?objectKind&objectId` | `UserView[]` — ACTIVE users holding the kind's `checkPermission`, in the object's teams (or any team when `team_ids='{}'`), minus me |
| `GET /v1/approvals/:id` | `@RequirePermission(APPROVALS_READ)` | — | `ProposalDetail`; 404 when out of scope |
| `POST /v1/approvals` | `@RequireAnyPermission(...APPROVAL_MAKE_PERMISSIONS)` | `ApprovalSubmitInput` | 201 `ProposalDetail`; 409 `approval_open`, 403 when the maker lacks `descriptor.makePermission`, 422 `checker_not_eligible` |
| `PATCH /v1/approvals/:id` | `@RequireAnyPermission(...APPROVAL_MAKE_PERMISSIONS)` | `ApprovalEditInput` | `ProposalDetail` (revision+1, `edited_after_submission=true`); 403 if not the maker |
| `POST /v1/approvals/:id/withdraw` | `@RequireAnyPermission(...APPROVAL_MAKE_PERMISSIONS)` | `{ reason }` | 204 |
| `POST /v1/approvals/:id/decision` | `@RequireAnyPermission(...APPROVAL_CHECK_PERMISSIONS)` | `ApprovalDecisionInput` | `ProposalDetail`; **409 `content_changed`** on hash mismatch, **409 `dependency_changed`**, 403 `self_review`, 403 `not_checker` |
| `POST /v1/approvals/bulk-decision` | `@RequireAnyPermission(...APPROVAL_CHECK_PERMISSIONS)` | `BulkDecisionInput` (max 50) | `BulkDecisionResult` — 200 even when everything was skipped |
| `POST /v1/approvals/:id/checker` | `@RequireAnyPermission(APPROVALS_REASSIGN_ANY, ...APPROVAL_CHECK_PERMISSIONS)` | `ReassignInput` | `ProposalDetail`; 422 `checker_not_eligible` when the target lacks the kind's check permission |

Object-side additions (owned by the object's module, calling into the spine):
- `POST /v1/agents/:id/status {status:'LIVE'}` → **409 `approval_required`** with `{ objectKind:'agent', action:'ACTIVATE' }` in `details`; the web turns that into the Submit-for-approval modal. `{status:'PAUSED'}` is unchanged and immediate.
- `PATCH /v1/agents/:id`, `PATCH /v1/queues/:id`, `PATCH /v1/channels/:id`, `POST /v1/agents/:agentId/prompt-versions/:id/activate`, `POST /v1/channels/:id/templates`, `POST /v1/mcp/connections/:id/{approve,enable}`, `PUT /v1/agents/:agentId/tools`, `PUT /v1/sla-policies/:id`, model provider/profile writes: when the object is already approved these return **409 `approval_required`** instead of applying; the client posts `/v1/approvals` with the same body as `payload`.
- `POST /v1/mcp/connections/:id/disable`, channel `status:'DISABLED'`, and the **removals** half of `PUT /v1/agents/:agentId/tools` stay direct and immediate.

New realtime events (`packages/events/src/catalogue.ts`), gated in apps/api/src/modules/realtime/realtime-access.ts (maker, checker, or `approvals.reassign_any`):
```ts
'approval.requested':       { proposalId; objectKind; objectId; action; makerId; checkerId }
'approval.decided':         { proposalId; objectKind; objectId; decision:'APPROVED'|'REJECTED'|'WITHDRAWN'|'BLOCKED'; checkerId: string|null; makerId }
'approval.checker_invalid': { proposalId; objectKind; checkerId; reason:'DISABLED'|'LOST_RIGHTS' }
```
New queue topics consumed in apps/worker/src/consumers/consumers.service.ts:
- `approval.notify` `{ proposalId, kind:'REQUESTED'|'DECIDED'|'CHECKER_INVALID' }` — concurrency 4, maxAttempts 5, backoff 5s.
- `approval.activate` `{ proposalId }` — concurrency 2, visibility 120s, maxAttempts 5 → `finishActivation`.
New leader tasks in apps/worker/src/scheduler/tasks.registry.ts:
- `approval-checker-sweep` every 300s → `revalidateCheckers` (flips `checker_valid`, emits `approval.checker_invalid`).
- `approval-notify-redispatch` every 300s → re-publishes `approval.notify` for SUBMITTED rows with `notified_at IS NULL` older than 60s.
- `approval-void-orphans` every 900s → VOIDs open proposals whose `descriptor.project()` returns null.

## permissions
Seven new constants in packages/auth/src/permissions.ts, under a new "Approvals (maker-checker)" block:

```ts
APPROVALS_READ:               'approvals.read',
APPROVALS_REASSIGN_ANY:       'approvals.reassign_any',
APPROVALS_CHECK_AGENTS:       'approvals.check.agents',        // agents, prompt versions, agent tool grants, escalation rules
APPROVALS_CHECK_ROUTING:      'approvals.check.routing',       // routers, routing rules, queues, SLA policies
APPROVALS_CHECK_CHANNELS:     'approvals.check.channels',      // channels, message templates
APPROVALS_CHECK_PLATFORM:     'approvals.check.platform',      // model providers/profiles, MCP connections, deployment/retention settings
APPROVALS_CHECK_PERMISSIONS:  'approvals.check.permissions',   // permission grants/revokes, preset changes
```
Plus two exported arrays used by the decorators and pinned by tests:
```ts
export const APPROVAL_CHECK_PERMISSIONS = [APPROVALS_CHECK_AGENTS, ...ROUTING, ...CHANNELS, ...PLATFORM, ...PERMISSIONS] as const;
export const APPROVAL_MAKE_PERMISSIONS = [AGENTS_MANAGE, PROMPTS_EDIT, PROMPTS_ACTIVATE, AGENT_TOOLS_MANAGE, ESCALATION_MANAGE, QUEUES_MANAGE, SLA_MANAGE, CHANNELS_MANAGE, MESSAGE_TEMPLATES_MANAGE, PROVIDERS_MANAGE, MODEL_PROFILES_MANAGE, MCP_MANAGE, USERS_MANAGE, USERS_MANAGE_EXECS, DEPLOYMENT_SETTINGS_MANAGE] as const;
```

Five check permissions rather than one per object kind: "approval rights for that object kind" is honoured because the descriptor names exactly one of them, while the grant surface stays small enough for a real bank to administer. Never a role, never a level.

Default preset grants (the per-user permissions area owns the final matrix; this is the shape it must satisfy):
- **Head** — all five check permissions + `approvals.read`. This is what produces "Lead → checked by Head" and "Head → checked by another Head" without any level anywhere.
- **Lead** — `approvals.read` only. Makes, cannot check.
- **Service** — `approvals.read` only (so "Sent by me" works when they have been granted a make right).
- **Tech** — `approvals.read`, `approvals.reassign_any`, `approvals.check.platform`, `approvals.check.permissions`. Tech is the platform/identity authority and must NOT hold check.agents/routing/channels, which would let it approve business content it is deliberately denied elsewhere.

Rule at decision time, evaluated in this order (`ApprovalDecisionService.decide`):
1. `status === 'SUBMITTED'` else 409 `not_open`.
2. `descriptor.assertVisible(tx, principal, objectId)` — ADR-026 scoping, 404 for another team's object.
3. `can(principal, descriptor.checkPermission)` else 403 `forbidden`.
4. `principal.userId !== proposal.maker_id` else 403 `self_review` (also a DB CHECK).
5. `principal.userId === proposal.checker_id` **or** `can(principal, APPROVALS_REASSIGN_ANY)` — the second is only for reassignment, never for deciding: deciding requires being the named checker. 403 `not_checker` otherwise.
6. Content hash + dependency hash match else 409.

Scoping (`approvalScope`): `approvals.reassign_any` → null (every open proposal). Otherwise `maker_id = me OR checker_id = me OR team_ids = '{}' OR team_ids && $myTeams`, and the `team_ids='{}'` (platform-wide) branch additionally requires holding at least one check permission — a Service member never sees platform proposals.

Reassignment: the reassigner needs `APPROVALS_REASSIGN_ANY` or the kind's `checkPermission`; the **new checker must hold the kind's checkPermission**, be ACTIVE, and not be the maker. That is the reading that makes "Tech can reassign" and "whoever reassigns must hold checker rights" both true.

Audit scope: `packages/application/src/audit/audit-scope.ts` gains one target branch —
```sql
(target_type='approval' AND target_id IN (
  SELECT id::text FROM approval_proposals
   WHERE maker_id = $me OR checker_id = $me OR team_ids = '{}'::uuid[] OR team_ids && $myTeams))
```

## ui
New screen **Approvals** at `/approvals` (path is free: not an app route today and not one of next.config.ts's API-rewritten prefixes). Nav item added twice in apps/web/lib/nav.ts, permission-gated as every other item: `{ key:'approvals', label:'Approvals', href:'/approvals', requires: P.APPROVALS_READ }` in the `governance` group and in the `oversight` group.

Files (each well under the 300-line guidance, split the way `alerts` is):
- `apps/web/app/(app)/approvals/page.tsx` — metadata, `import '@/app/styles/ops.css'`, `<AppTopbar/>` + `<PageBody><ApprovalsBody …/></PageBody>`. Sync; `searchParams` awaited inside the body (cacheComponents is on).
- `components/approvals/approvals-meta.ts` — `ApprovalsParams`, `parseApprovalsParams`, `approvalsHref`, `toApiQuery`. Pure, unit-tested.
- `components/approvals/approvals-body.tsx` — `requireSession()`, `NotPermitted` without `approvals.read`, permission-filtered tab strip via `Tabs` + `TabPanel`, `<LiveRefresh events={['approval.requested','approval.decided','approval.checker_invalid']} />` as `Tabs trailing`.
- `components/approvals/approvals-inbox.tsx` — `Promise.all` of counts + page + selected detail + checker candidates; filter chips as `<Link>` with counts and `aria-current`; `DataTable` label "Approvals"; cursor Newest/Older links.
- `components/approvals/approval-row-select.tsx` — the bulk checkbox column (client).
- `components/approvals/bulk-bar.tsx` — sticky "Approve 7 selected · 2 excluded", one reason field, one submit.
- `components/approvals/approval-drawer.tsx` — server-rendered, `key={id+'-'+status+'-'+revision}`, `closeHref` (RoutedDrawer pattern).
- `components/approvals/approval-diff.tsx` — renders `DiffField[]` from `@ocso/domain`; before/after columns, added/removed/changed marks.
- `components/approvals/decision-form.tsx` — Approve / "Reject with reason", the `contentHash` carried in a hidden input, reusing the vocabulary of `components/workspace/confirm-card.tsx` (risk-style header, facts, deny-with-reason). Read-only variant when `canDecide` is false.
- `components/approvals/submit-modal.tsx` — mounted on object screens: checker `<select>` from `GET /v1/approvals/checkers`, reason textarea, a preview of `changedFields`. `useActionState` + `queue-form-modal.tsx` shape.
- `components/approvals/pending-badge.tsx` — "Pending approval · awaiting {name}" / "Approved — activating" chip for agent, queue, channel, template and connection detail pages.
- `components/approvals/lib/selection.ts` and `lib/warnings.ts` — pure, unit-tested: which rows are selectable, warning copy, exclusion counts.
- `lib/api/approvals.ts` (`import 'server-only'`, zod schema per response) and `lib/actions/approvals.ts` (the `run(schema, raw, call, permission?)` helper from `lib/actions/alerts.ts`, `refresh()` from `next/cache`).
- `components/approvals/approval-notices-slot.tsx` + `approval-notices.tsx` + `lib/notices.ts` — modelled exactly on `components/templates/template-notices*`, mounted once in `app/(app)/layout.tsx`. The maker is told "Your change to Maya was approved / rejected"; the checker is told "3 changes are waiting for you".
- `lib/realtime/events.ts` — the three new types added to **both** `RealtimePayloads` and `REALTIME_EVENT_TYPES` (otherwise they are silently dropped twice).
- `components/audit/audit-meta.ts` — `'approval'` added to `TARGET_TYPES`.

Who sees what:
- **Awaiting me** — proposals where I am the named checker. Head sees these; Lead and Service normally see an empty state with the honest line "Nothing is waiting for your decision."
- **Sent by me** — anyone who can submit, including a Service member with a granted make right.
- **All open** — only with `approvals.reassign_any` (Tech). Adds a "Reassign" action on every row and a "Needs a new checker" filter chip.
- **Decided** — the same scope as the list, status ≠ SUBMITTED, newest first.
- Rows with a blocking warning render the bulk checkbox **disabled** with the reason as its `title`, and a warning dot in the row; the bulk bar's "2 excluded" links to the first of them.
- Reject requires a reason ≥ 3 characters; the button stays disabled until it is entered (and the API enforces it).

## behaviour
**State machine** (`approvalTransition`, closed table, everything else throws):
```
(no proposal) --SUBMIT--> SUBMITTED
SUBMITTED --EDIT(maker)--> SUBMITTED        revision+1, edited_after_submission=true, hashes recomputed
SUBMITTED --WITHDRAW(maker)--> WITHDRAWN
SUBMITTED --REASSIGN--> SUBMITTED           checker_id replaced, checker_valid=true, no revision bump
SUBMITTED --REJECT--> REJECTED              resubmission = a NEW proposal (revision restarts at 1)
SUBMITTED --APPROVE--> APPROVED             same transaction: descriptor.activate
SUBMITTED --BLOCK--> BLOCKED                validation failed at activation; object untouched
SUBMITTED --VOID--> VOID                    the object no longer exists
APPROVED(activated_at NULL) --ACTIVATE--> APPROVED(activated_at set)   deferred path
APPROVED(activated_at NULL) --BLOCK--> BLOCKED                         deferred path failed
```
REJECTED / WITHDRAWN / BLOCKED / VOID are terminal. A BLOCKED or REJECTED object is unlocked, so the maker fixes it and submits again.

**What "inert until approved" means per kind**
| kind | never-approved state | ACTIVATE / CREATE approval does |
|---|---|---|
| `agent` | `virtual_agents.status='DRAFT'` — the turn processor skips it (`status==='LIVE'` gate) | runs the existing LIVE preconditions and sets `status='LIVE'` |
| `prompt_version` | row exists (already immutable), `virtual_agents.active_prompt_version_id` unchanged | stamps `active_prompt_version_id`, `first_activated_at`, bumps `agent:<id>` |
| `message_template` | `status='DRAFT'`, never sent to the provider | **DEFERRED** — the worker submits to the provider and stores the returned id |
| `router` / `routing_rule` | the router area's `enabled=false`; the rule never fires | flips `enabled=true` |
| `queue` / `sla_policy` | not referenced by any live router | the patch applies |
| `channel` | `status='DRAFT'`, webhook rejects inbound | `status='ACTIVE'` |
| `mcp_connection` / `agent_tool_grant` | `approved=false` / grant absent; `authorizeToolCall` already refuses | **DEFERRED** for connection enable (network); grant additions apply in-transaction |
| `model_provider` / `model_profile` | not selectable by a live agent | the patch applies |
| `permission_change` | the grant row exists with no effective-from (the permissions area's column) | the grant becomes effective |
| `deployment_settings` / retention | the patch is not applied | the patch applies |

**Submit** (`ApprovalService.submit`, one transaction)
1. `registry.get(objectKind)`; the action must be in `descriptor.actions` else 422 `action_not_approvable`.
2. `assertCan(principal, descriptor.makePermission)`; `descriptor.assertVisible`.
3. `descriptor.payload.parse(input.payload)` when the action is CREATE/UPDATE; `{}` otherwise.
4. Advisory lock on `hashtext('ocso:approval:'||kind||':'||objectId)` then the partial unique index → 409 `approval_open`.
5. Checker eligibility: ACTIVE, holds `descriptor.checkPermission`, is not the maker, and is in the object's teams (or any team for platform-wide) → 422 `checker_not_eligible`.
6. `before_snapshot = sanitizeForAudit(await descriptor.project(tx, objectId))`, `after_snapshot = sanitizeForAudit(await descriptor.projectAfter(...))`, `team_ids`, `dependency_keys`/`dependency_hash`, `content_hash`, `title`.
7. `descriptor.validate` — hard problems refuse the submit (422 `validation_failed`), soft ones are stored in `warnings`.
8. INSERT proposal + a `SUBMIT` decision row carrying `diffFields(before, after)` + `recordAudit(tx, actor, {action:'approval.submit', targetType:'approval', targetId: id, summary: title, after: {objectKind, objectId, action, checkerId}})` + `emitEvent('approval.requested')`. After commit, publish `approval.notify`.

**Evaluation order at decision** — the six steps in the permissions field, then, inside one transaction:
- `SELECT … FOR UPDATE` the proposal.
- Recompute `content_hash` from the live row; compare with the request's `contentHash` **and** with the stored hash. Mismatch → 409 `content_changed` and a `warnings` refresh. This is the mechanism by which "an edit after approval voids the approval": the checker can only ever approve exactly the bytes they were shown.
- Recompute `dependency_hash` from `descriptor.dependencies`; mismatch → 409 `dependency_changed`.
- REJECT: status REJECTED, `decided_*`, a `REJECT` decision row with the diff, `recordAudit('approval.reject')`, `emitEvent('approval.decided')`.
- APPROVE: run `descriptor.validate` **again, here**. If it returns problems → status BLOCKED, `blocked_reason`, a `BLOCK` decision row, `recordAudit('approval.block')`, and **commit** (the object was never touched). Otherwise `descriptor.activate(tx, actor, proposal)`:
  - `DONE` → status APPROVED, `activated_at=now()`, an `APPROVE` and an `ACTIVATE` decision row, `recordAudit('approval.approve')` + `recordAudit('approval.activate')`. The descriptor has already written the object's own audit row (`agent.update`, `prompt.activate`, …) and bumped its cache generation in the same transaction, so every existing audit and cache consumer is untouched.
  - `DEFERRED` → status APPROVED, `activated_at` NULL. After commit, publish `approval.activate`.
- If `activate` throws a genuine error the whole transaction rolls back, the proposal stays SUBMITTED, and the API returns the DomainError. Nothing half-applies.

**Deferred activation** (`finishActivation`, worker, no transaction around the provider call): reload; skip unless APPROVED with `activated_at IS NULL`; **re-run `validate` and re-check both hashes**; `activation_attempts++`; call `activateDeferred`; on success stamp `activated_at` + `ACTIVATE` decision + audit in a short transaction; on a terminal failure (or attempts ≥ 5) → BLOCKED with the provider's message. Nothing the provider rejects ever shows as live.

**Bulk approve**: one `bulk_batch_id` for the call, then a loop — each id gets its own transaction and the full single-item path, including its own diff, reason, decision row and audit event. Any id that raises a blocking warning, fails its hash check, fails validation, is not open, or is not mine to check lands in `skipped[]` with a code. The API returns 200 with both lists; the UI shows "5 approved, 2 need you to open them". Cap 50 per call. Bulk is APPROVE only — rejection needs a per-item reason, and the owner asked only for bulk approve.

**Edits void approvals two ways**: (a) the maker's `PATCH` bumps `revision`, recomputes `content_hash`, sets `edited_after_submission=true` (permanently, until the proposal is decided) which is a blocking bulk warning — "must be opened individually"; (b) any checker request carrying a stale `contentHash` is 409. Because the object itself is locked while a proposal is open (`assertChangeAllowed`), there is no third way for content to drift.

**Checker loses rights or leaves**
- Decision time is the real enforcement: step 3 re-reads permissions per request (OCSO caches nothing) and 403s.
- `approval-checker-sweep` (300s) re-evaluates each open proposal's checker (ACTIVE + holds `descriptor.checkPermission` under the per-user effective-permission model) and sets `checker_valid=false`, emits `approval.checker_invalid`, and enqueues a notify to holders of `approvals.reassign_any`. It **never auto-reassigns** — silently moving authority is exactly what maker-checker exists to prevent.
- `checker_valid=false` is a blocking bulk warning and shows as a "Needs a new checker" chip. A human with reassignment rights names a new checker.
- Users are never hard-deleted (status DISABLED), so `checker_id` never dangles; the FK has no cascade.

**Interaction with pause/disable being exempt**
- `assertChangeAllowed` is called only on approvable actions. `setStatus('PAUSED')`, `PATCH /v1/channels/:id {status:'DISABLED'}`, `POST /v1/mcp/connections/:id/disable` and tool-grant **removals** never call it and never look at a proposal.
- Pausing an object with an open proposal leaves the proposal open. If that proposal is later approved, activation re-validates and for `agent` ACTIVATE would take it live again — which is correct: approving "take Maya live" after someone paused her is a decision, and the checker sees the current state in the diff's `before`.
- `PUT /v1/agents/:agentId/tools` is a mixed call: `AgentToolGrantService.replace` computes the delta, commits the **removals** immediately with their own `agent_tool_grant.revoke` audit rows, and, if there are additions, opens an UPDATE proposal carrying only the additions. One call, two honest outcomes; the response says so.
- A pinned test asserts no descriptor registers a pause/disable/revoke action and that `RUNTIME_KINDS` (`conversation`, `handoff`, `interaction`, `assignment`, `tool_call`) are never registered — claiming, replying and resolving are never approved.

## migration
Two additive migrations, no file ever edited, no downtime, no reconfiguration. The migrate container's existing single `DATABASE_URL` run covers both.

**`packages/db/migrations/0021_approvals.sql`** (hand-written; numbering must not collide with a drizzle-kit 0021 — generate the schema first, then rename if needed)
1. `CREATE TABLE approval_proposals (…)` with the four CHECKs.
2. `CREATE TABLE approval_decisions (…)` with its CHECK.
3. All indexes listed in the data model, including `CREATE UNIQUE INDEX approval_proposals_open_uq ON approval_proposals(object_kind, object_id) WHERE status = 'SUBMITTED';` (plain `CREATE INDEX` — the runner wraps each file in a transaction, so `CONCURRENTLY` is not available; the tables are empty at this point so it costs nothing).
4. `CREATE FUNCTION ocso_reject_decision_mutation()` raising `insufficient_privilege` with `approval_decisions is append-only`, and the two triggers (a separate function from `ocso_reject_audit_mutation`, which 0010 already CREATE-OR-REPLACEd; do not touch it).
5. `ALTER TABLE deployment_settings ADD COLUMN approval_age_warning_hours integer NOT NULL DEFAULT 72;`

**`packages/db/migrations/0022_approvals_grandfather.sql`** (hand-written). Everything already live counts as approved, recorded honestly rather than silently:
```sql
INSERT INTO approval_proposals
  (id, object_kind, object_id, action, status, origin, payload, before_snapshot, after_snapshot,
   content_hash, dependency_hash, team_ids, title, reason, maker_id, checker_id,
   submitted_at, decided_at, decision_reason, activated_at, created_at, updated_at)
SELECT gen_random_uuid(), 'agent', va.id, 'CREATE', 'APPROVED', 'MIGRATION', '{}', NULL, NULL,
       'ap_migration', 'ad_migration', COALESCE(ARRAY(SELECT team_id FROM agent_teams WHERE agent_id = va.id), '{}'),
       'Existing virtual agent ' || va.name,
       'Configuration that predates maker-checker (migration 0022)',
       NULL, NULL, now(), now(), 'Grandfathered at rollout', now(), now(), now()
  FROM virtual_agents va WHERE va.status IN ('LIVE','PAUSED');
```
plus one near-identical statement per kind, separated by `--> statement-breakpoint`:
`prompt_version` (rows referenced by `virtual_agents.active_prompt_version_id`), `channel` (`status='ACTIVE'`), `message_template` (`status='APPROVED' AND deleted_at IS NULL`), `model_provider` and `model_profile` (all existing), `mcp_connection` (`approved = true`), `queue` and `sla_policy` (all existing), `agent_tool_grant` (all existing), `escalation_rule` (all existing), and `deployment_settings` (the singleton, `object_id` = the all-zero uuid since the table's key is `smallint` 1 — `'00000000-0000-0000-0000-000000000001'`, a constant exported as `SINGLETON_OBJECT_ID`).

Ordering: **0022 must run after the routers/queues migration from the routing area**, so its new pass-through router and its queues get a grandfather row too. If routing lands as 0023, the grandfather insert for `router`/`routing_rule` belongs in that file, not here — name it in the PR description.

Live demo (one Twilio WhatsApp channel, agent "Maya", one OpenAI provider): after 0022 there are ~8 MIGRATION rows. Maya stays LIVE, the channel stays ACTIVE, the webhook keeps delivering, the turn loop is untouched (it reads `virtual_agents.status`, which nothing changes). The only behaviour change is that the next edit to any of them now needs a checker — which is the point, and which is why 0022 exists rather than leaving everything looking like "live without approval" in the exception report.

Rollback: both migrations are pure additions; dropping the two tables and the column restores the previous behaviour, but the guard calls in the services would have to be reverted with them. There is no data loss path.

Deployment order for the PR: schema + migrations → `@ocso/auth` permissions → descriptors and guard calls → API module → worker consumers/tasks → web. Because `apps/web` filters unknown permission strings through `isPermission` (lib/session.ts:32), the web build must ship the new `@ocso/auth` or the Approvals nav item simply does not appear — deploy them together.

## tests
**Unit (`pnpm test`)**
- `packages/domain/test/approvals/state.test.ts` — every legal transition; `approvalTransition('APPROVED','APPROVE')` throws; terminal statuses accept nothing; `BULK_BLOCKING` contains every code except `aged`.
- `packages/domain/test/approvals/diff.test.ts` — added/removed/changed, nested dotted paths, array replacement, depth and field caps, `describeDiff` wording, stable ordering for equal inputs.
- `packages/auth/test/rbac.test.ts` (extended, table-driven) — Head holds all five check permissions; Lead and Service hold none; Tech holds platform + permissions but **not** agents/routing/channels; `APPROVAL_CHECK_PERMISSIONS` equals the union of the descriptors' `checkPermission`s; every new permission is granted to at least one preset (the existing structural invariant).
- `packages/application/test/approvals/coverage.test.ts` — `APPROVAL_DESCRIPTORS.kinds()` equals a reviewed `APPROVABLE_KINDS` list (adding a config object fails CI until its descriptor exists); no descriptor lists a stop action; `RUNTIME_KINDS` are absent; every `checkPermission` is in `APPROVAL_CHECK_PERMISSIONS`; every `makePermission` is in `APPROVAL_MAKE_PERMISSIONS`.
- `packages/application/test/approvals/payload-redaction.test.ts` — for each descriptor's sample payload, `sanitizeForAudit(payload)` deep-equals `payload`: a payload that would have been masked carries a secret and must use a `secretRef` instead.
- `packages/application/test/approvals/warnings.test.ts` — pure warning evaluation for each code, and `blocksBulk` flags.
- `apps/api/test/unit/route-access.test.ts` (existing, unchanged assertions) — proves every new handler declares an access rule and that `PUBLIC_ROUTES` did not grow.
- `apps/web/test/unit/approvals/meta.test.ts` — `parseApprovalsParams` drops junk and requires UUIDs; `approvalsHref` omits defaults; round-trips.
- `apps/web/test/unit/approvals/selection.test.ts` — rows with a blocking warning are unselectable; "n excluded" counts; select-all skips them.
- `apps/web/test/unit/nav.test.ts` (extended) — Approvals appears for `approvals.read` and is absent without it.

**Integration, real Postgres (`*.int.test.ts`, `createTestDatabase`)**
- `packages/application/test/approvals/spine.int.test.ts` — submit → approve → the agent is LIVE and `virtual_agents` shows the change; one `audit_events` row for `approval.approve` and one for the object's own action, both in the same transaction; `approval_decisions` has SUBMIT + APPROVE + ACTIVATE.
- `…/one-open-proposal.int.test.ts` — a second submit for the same object is 409 `approval_open`; a different object is fine; after rejection a new proposal is allowed.
- `…/object-locked.int.test.ts` — `AgentService.update` on an object with an open proposal throws `approval_open`; `setStatus('PAUSED')` succeeds in the same state; tool-grant removal succeeds while an addition proposal is open.
- `…/content-hash.int.test.ts` — the maker edits, the checker posts the old hash → 409 `content_changed`; posting the new hash succeeds; `edited_after_submission` survives until decision.
- `…/dependency-changed.int.test.ts` — the model profile referenced by a pending agent change is edited; the decision is 409 `dependency_changed` and the warning appears on GET.
- `…/revalidate-at-activation.int.test.ts` — an agent ACTIVATE proposal is approved after its model profile was deleted: the proposal ends BLOCKED, `virtual_agents.status` is still DRAFT, and `approval_decisions` has a BLOCK row.
- `…/deferred-activation.int.test.ts` — a message-template ACTIVATE stays `APPROVED/activated_at NULL`; `finishActivation` with a mutated payload is BLOCKED and never calls the provider double; a clean run stamps `activated_at` and stores the provider id.
- `…/bulk-approve.int.test.ts` — 5 selected, 2 carrying warnings: 3 approved with 3 distinct decision rows sharing a `bulk_batch_id`, 2 in `skipped[]` with codes; each approved object has its own diff and reason.
- `…/checker-lifecycle.int.test.ts` — the checker is disabled → the sweep sets `checker_valid=false` and emits the event; a decision attempt by them is 403; reassignment to an eligible Head succeeds and to a Lead is 422.
- `…/self-review.int.test.ts` — naming yourself as checker is 422 at submit; the DB CHECK rejects a direct insert; approving your own proposal after a reassignment to you is 403 `self_review`.
- `…/immutability.int.test.ts` — `UPDATE`/`DELETE`/`TRUNCATE` on `approval_decisions` raise `approval_decisions is append-only` (the pattern of `packages/db/test/migrations.int.test.ts:51-57`).
- `apps/api/test/int/approvals-scope.int.test.ts` — on the two-team ownership fixture (`packages/application/test/support/ownership-fixture.ts`): a Head of team A does not see team B's proposals; Tech with `approvals.reassign_any` sees both; a Service member sees only "sent by me"; audit rows for `target_type='approval'` follow the same scope.
- `apps/api/test/int/approvals-flow.int.test.ts` — the full HTTP story through `startApi`/`completeSetup`/`loginAs`: `POST /v1/agents/:id/status {LIVE}` → 409 `approval_required`; `POST /v1/approvals` → 201; the checker's `GET /v1/approvals?box=AWAITING_ME` shows it; `POST .../decision` → the agent is LIVE; the maker's email is in `emailsTo(...)` with the approval subject.
- `packages/db/test/migrations.int.test.ts` (extended) and a partial-migration test in the style of `better-auth-upgrade.int.test.ts` — seed a live agent, channel, provider and template against migrations `< 0021`, run the rest, and assert exactly one `origin='MIGRATION'` APPROVED proposal per live object, that nothing became DRAFT, and that `isApproved()` is true for all of them.

**Playwright (`apps/web/e2e/approvals.spec.ts`, serial, seeded through the real API in `beforeAll`)**
- A Lead submits a change to an agent and sees it under "Sent by me" with the diff.
- A Head signs in, sees it under "Awaiting me", opens the drawer, reads the diff, approves with a reason; the agent screen shows it live.
- Bulk: five items, two with warnings; select-all leaves two checkboxes disabled; the bar reads "Approve 3 selected · 2 excluded"; after approval the two remain.
- Rejection with a reason returns the object to the maker, who resubmits.
- A CS Exec sees `NotPermitted` at `/approvals` ("Not available for your role"), matching `ops.spec.ts:310-313`.
- `expectNavLinksResolve` keeps passing for each role (every sidebar link 200s and renders an `h1`).

## risks
- Coverage is the whole risk. A write path that forgets `assertChangeAllowed` silently bypasses maker-checker and nothing fails at runtime. Mitigated by `coverage.test.ts` (the descriptor list must equal a reviewed kind list) plus a reviewed `APPROVABLE_ROUTES` table in the API unit test — but neither proves the *service* consulted the guard. The honest residual: a new service method added later can still slip through, exactly as a new `@Public()` route could before `route-access.test.ts` existed. Consider a follow-up guard that asserts each descriptor's kind appears in its service's write path.
- `payload` must be replayable, so it cannot be redacted — it is stored raw and never returned over HTTP. The compensating rule is that a payload must never carry a secret value (only a `secretRef`), pinned by `payload-redaction.test.ts`. A descriptor author who breaks that rule writes a secret into the main database in plaintext-ish JSON.
- Locking the object while a proposal is open (409 `approval_open`) is a real usability cost: a maker who submits and then spots a typo must edit the proposal, not the object, and every object screen needs the read-only + badge treatment. The alternative — letting the object drift and voiding the approval — is worse, but this will generate support questions in the first weeks.
- `team_ids` is a snapshot taken at submit. If an agent's owning teams change while a proposal is open, the proposal's visibility is briefly stale. `descriptor.assertVisible` at decision time is the real check, so nobody can *decide* out of scope, but someone may *see* a row they have just lost rights to until the next sweep.
- Deferred activation splits approval from effect for message templates and MCP connections. Between APPROVED and `activated_at` the object is approved but not yet live; if the worker leader is down the state persists. The UI names it (`ACTIVATING`) and the exception report should list `APPROVED AND activated_at IS NULL older than an hour` — a dependency on area E.
- Grandfathering by inserting MIGRATION proposals is honest but adds one row per existing config object. On a deployment with thousands of templates the 0022 insert is a single pass but the exception report must distinguish `origin='MIGRATION'` from a real approval, or every legacy object reads as an audit finding.
- `approval_decisions` is append-only in the main database with the same trigger technique as `audit_events`. If the audit store moves out (area D) and someone assumes decisions moved with it, governance queries split across two databases. The decision here is deliberate: decisions stay in the main DB because they are operational state, and only the audit *events* about them ship out.
- The bulk endpoint runs up to 50 sequential transactions in one request. With slow descriptors (a queue with many teams) that can approach the BFF's 10s client timeout (`apps/web/lib/api/client.ts:13`), and a timeout is not retried by design. Cap 50 and a measured `validate` keep it safe; if it proves tight, the answer is a smaller cap, not a background job, because the checker must see per-item outcomes.