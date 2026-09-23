import Link from 'next/link';
import { Permission } from '@ocso/auth';
import { TEMPLATE_STATUS_LABELS, type TemplateStatus } from '@ocso/domain';
import { NotPermitted } from '@/components/shell/placeholder-page';
import { EmptyState } from '@/components/ui/empty-state';
import { SecHead } from '@/components/ui/sec-head';
import { StatusChip, type StatusTone } from '@/components/ui/status-chip';
import { CATEGORY_LABELS, listProblemText } from '@/components/workspace/lib/template';
import { loadChannelTemplates, loadTemplateChannels, type TemplateChannel, type TemplateView } from '@/lib/api/templates';
import { formatAge } from '@/lib/format';
import { hasPermission, requireSession } from '@/lib/session';
import { PendingBadge } from '@/components/approvals/pending-badge';
import { DeleteTemplateButton, SubmitDraftButton, TemplatesLive } from './template-actions';
import { TemplateBuilder } from './template-builder';
import { formFromTemplate } from './lib/draft-form';

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const STATUS_TONE: Readonly<Record<TemplateStatus, StatusTone>> = { APPROVED: 'good', PENDING: 'accent', DRAFT: 'muted', REJECTED: 'danger', PAUSED: 'warn', DISABLED: 'danger' };

export const templatesHref = (channelId: string, extra: Record<string, string> = {}) => `/templates?${new URLSearchParams({ channel: channelId, ...extra }).toString()}`;

/** The kind's own words for its templates; plain defaults when the API has none. */
const termsOf = (channel: TemplateChannel) => channel.templates ?? { reviewer: 'the provider', placeholderScope: 'template' as const };

/**
 * Message templates page (docs/07 §3, docs/09 §6): the channels with
 * templates that a Lead's teams use (every one for a Tech admin), each
 * channel's templates with review status and rejection reasons, and the
 * builder that submits new ones for the provider's review.
 */
export async function TemplatesBody({ searchParams }: { searchParams: Promise<Params> }) {
  const [session, params] = await Promise.all([requireSession(), searchParams]);
  if (!hasPermission(session, Permission.MESSAGE_TEMPLATES_MANAGE)) return <NotPermitted role={session.roleLabel} />;
  const channels = await loadTemplateChannels();
  if (!channels.length) {
    return (
      <EmptyState title="No channel with message templates to manage">
        {hasPermission(session, Permission.CHANNELS_MANAGE)
          ? 'Add a channel whose provider reviews templates (e.g. WhatsApp) under Connections → Channels; its templates appear here.'
          : 'Templates belong to channels used by your teams’ virtual agents whose provider reviews templates (e.g. WhatsApp). None is attached yet — a Tech admin adds channels and a Lead attaches them to an agent.'}
      </EmptyState>
    );
  }
  const channel = channels.find((c) => c.id === one(params['channel'])) ?? channels[0]!;
  const creating = one(params['new']) === '1';
  const editId = one(params['edit']);
  const editing = editId ? (await loadChannelTemplates(channel.id)).templates.find((t) => t.submission?.recordId === editId && t.submission.draft && !t.submission.approval) : undefined;
  const can = { delete: hasPermission(session, Permission.MESSAGE_TEMPLATES_DELETE) };
  return (
    <div className="tpl-page">
      <ChannelPicker channels={channels} current={channel.id} />
      {creating || editing ? (
        <>
          <SecHead
            title={editing ? `Edit draft · ${editing.name}` : `New template · ${channel.name}`}
            desc={`${channel.kindLabel} · saved as a draft; a checker approves it before it goes to ${termsOf(channel).reviewer} for review`}
          />
          <TemplateBuilder
            key={editing?.id ?? 'new'}
            channel={channel}
            terms={termsOf(channel)}
            listHref={templatesHref(channel.id)}
            draft={editing ? { recordId: editing.submission!.recordId, form: formFromTemplate(editing) } : null}
          />
        </>
      ) : (
        <ChannelTemplates channel={channel} can={can} refresh={one(params['refresh']) === '1'} submitted={one(params['submitted']) ?? null} drafted={one(params['drafted']) ?? null} />
      )}
    </div>
  );
}

function ChannelPicker({ channels, current }: { channels: TemplateChannel[]; current: string }) {
  if (channels.length < 2) return null;
  return (
    <nav className="tpl-channels" aria-label="Channels with templates">
      {channels.map((c) => (
        <Link key={c.id} href={templatesHref(c.id)} className={c.id === current ? 'fchip active' : 'fchip'} aria-current={c.id === current ? 'page' : undefined}>
          {c.name}
        </Link>
      ))}
    </nav>
  );
}

type Can = { delete: boolean };

async function ChannelTemplates({ channel, can, refresh, submitted, drafted }: { channel: TemplateChannel; can: Can; refresh: boolean; submitted: string | null; drafted: string | null }) {
  const list = await loadChannelTemplates(channel.id, refresh);
  const approved = list.templates.filter((t) => t.status === 'APPROVED').length;
  return (
    <>
      <TemplatesLive channelId={channel.id} />
      <SecHead
        title={`Templates · ${channel.name}`}
        count={`${list.templates.length} · ${approved} approved`}
        desc={`${channel.kindLabel}${list.fetchedAt ? ` · checked ${formatAge(list.fetchedAt)} ago` : ''}`}
        actions={
          <>
            <Link className="btn tiny ghost" href={templatesHref(channel.id, { refresh: '1' })}>
              Refresh
            </Link>
            <Link className="btn tiny accent" href={templatesHref(channel.id, { new: '1' })}>
              New template
            </Link>
          </>
        }
      />
      {submitted ? (
        <div className="alert" role="status">
          <span>
            <b>{submitted}</b> is waiting for a checker. Once they approve, it goes to {termsOf(channel).reviewer} for review (usually minutes, up to 24 hours); this list and your notifications update as it moves.
          </span>
        </div>
      ) : null}
      {drafted ? (
        <div className="alert" role="status">
          <span>
            <b>{drafted}</b> was saved as a draft. {termsOf(channel).reviewer} never sees it until you submit it and a checker approves.
          </span>
        </div>
      ) : null}
      {list.problem ? (
        <div className="alert warn" role="alert">
          <span>{listProblemText(list.problem)}</span>
        </div>
      ) : null}
      {list.templates.length === 0 ? (
        <EmptyState title="No templates yet">
          {list.problem ? 'Templates submitted from OCSO still appear here while the provider list is unavailable.' : 'Create one with New template, or in the provider’s own console — both show up here.'}
        </EmptyState>
      ) : (
        <div className="tpl-list" role="list" aria-label="Templates">
          {list.templates.map((t) => (
            <TemplateRow key={t.id} channelId={channel.id} template={t} can={can} />
          ))}
        </div>
      )}
    </>
  );
}

function TemplateRow({ channelId, template: t, can }: { channelId: string; template: TemplateView; can: Can }) {
  const text = [t.header?.text, t.body, t.footer].filter(Boolean).join('\n');
  const sub = t.submission;
  const draft = Boolean(sub?.draft);
  const waiting = sub?.approval ?? null;
  const by = sub ? `${draft ? 'drafted' : 'submitted'} by ${sub.submittedBy?.name ?? (sub.providerMade ? 'the provider console' : 'a former user')} ${formatAge(sub.submittedAt)} ago` : null;
  return (
    <div className="tpl-row" role="listitem" aria-label={`${t.name} (${t.language})`}>
      <div>
        <span className="nm">{t.name}</span> <span className="mono-sm">· {t.language}{t.contentType ? ` · ${t.contentType}` : ''}</span>
        <p className="tx">{text || '—'}</p>
        {t.buttons.length ? <p className="mono-sm">buttons: {t.buttons.map((b) => b.text).join(' · ')}</p> : null}
        {t.rejectionReason ? <p className="why">{t.rejectionReason}</p> : null}
        {t.status === 'APPROVED' && !t.unsupportedReason ? <p className="mono-sm">execs can send it from a conversation’s composer (Template)</p> : null}
        {draft ? <p className="mono-sm">a draft: only OCSO has it — submit it for a checker’s approval to send it for review</p> : null}
        {t.unsupportedReason ? <p className="mono-sm">{t.unsupportedReason}</p> : null}
      </div>
      <div className="side">
        <span className="rowsplit">
          {t.category ? <StatusChip tone="muted">{CATEGORY_LABELS[t.category]}</StatusChip> : null}
          <StatusChip tone={STATUS_TONE[t.status]}>{draft ? 'Draft' : TEMPLATE_STATUS_LABELS[t.status]}</StatusChip>
        </span>
        {waiting ? (
          <PendingBadge
            state={{
              approved: !draft,
              pending: { id: waiting.proposalId, action: waiting.action, status: waiting.activating ? 'APPROVED' : 'SUBMITTED', checkerId: null, checkerName: waiting.checkerName, makerId: null, submittedAt: '', activating: waiting.activating },
              updateNeedsApproval: true,
              checkPermission: '',
            }}
          />
        ) : null}
        {by ? <span className="mono-sm">{by}</span> : null}
        <span className="rowsplit">
          {draft && !waiting ? (
            <>
              <Link className="btn tiny ghost" href={templatesHref(channelId, { edit: sub!.recordId })} aria-label={`Edit ${t.name}`}>
                Edit
              </Link>
              <SubmitDraftButton channelId={channelId} recordId={sub!.recordId} name={t.name} />
            </>
          ) : null}
          {can.delete ? <DeleteTemplateButton channelId={channelId} templateId={t.id} recordId={sub?.recordId ?? null} name={t.name} draft={draft} disabled={Boolean(waiting)} /> : null}
        </span>
      </div>
    </div>
  );
}
