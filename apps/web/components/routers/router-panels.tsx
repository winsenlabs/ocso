'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ConfirmButton } from '@/components/agents/shared/confirm-button';
import { ApprovableButton } from '@/components/approvals/approvable-button';
import { useApprovalRequest } from '@/components/approvals/use-approval-request';
import { AlertBanner } from '@/components/ui/alert-banner';
import { activateRouterAction, deleteRouterAction, disableRouterAction, saveRouterDraftAction, setRouterChannelsAction } from '@/lib/actions/routers';
import type { RouterDefinition } from '@ocso/domain';

export interface VersionRow {
  id: string;
  version: number;
  reason: string;
  createdAt: string;
}

/**
 * Versions and activation (PM/research/11 §5.7): the newest frozen version is
 * what an activation proposal takes live — or resumes a disabled router
 * with. The live version can be restored as the draft.
 */
export function VersionsPanel({
  routerId,
  name,
  status,
  versions,
  activeVersionId,
  activeDefinition,
  pending,
  canManage,
}: {
  routerId: string;
  name: string;
  status: 'DRAFT' | 'ACTIVE' | 'DISABLED';
  versions: VersionRow[];
  activeVersionId: string | null;
  activeDefinition: RouterDefinition | null;
  pending: boolean;
  canManage: boolean;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const latest = versions[0];
  const resume = status === 'DISABLED';
  const canActivate = canManage && latest && !pending && !(status === 'ACTIVE' && latest.id === activeVersionId);
  return (
    <section className="rt-panel" aria-label="Versions">
      <h3 className="rt-h">Versions</h3>
      {versions.length === 0 ? <p className="mono-sm">No versions yet: save the draft as a version to activate it.</p> : null}
      <ol className="rt-versions">
        {versions.map((v) => (
          <li key={v.id}>
            <b>v{v.version}</b>
            {v.id === activeVersionId ? <span className={`schip ${status === 'ACTIVE' ? 'good' : 'warn'}`}>{status === 'ACTIVE' ? 'live' : 'disabled'}</span> : null}
            <span className="mono-sm">{v.reason || 'no note'}</span>
          </li>
        ))}
      </ol>
      {canActivate ? (
        <ApprovableButton
          label={resume ? `Resume with v${latest.version}` : `Activate v${latest.version}`}
          title={resume ? `Resume router ${name}` : `Activate router ${name} v${latest.version}`}
          confirmLabel="Submit for approval"
          target={{ objectKind: 'router', objectId: routerId, title: resume ? `Resume router ${name} (v${latest.version})` : `Activate router ${name} v${latest.version}` }}
          write={(approval) => activateRouterAction(routerId, latest.id, approval)}
          always
          buttonClass="btn accent"
        >
          v{latest.version} starts routing this router’s channels once a checker approves it.
        </ApprovableButton>
      ) : null}
      {canManage && activeDefinition ? (
        <button
          type="button"
          className="btn tiny ghost"
          onClick={async () => {
            const r = await saveRouterDraftAction(routerId, activeDefinition);
            setNotice(r.ok ? 'The live version is now the draft.' : r.message);
          }}
        >
          Restore the live version as the draft
        </button>
      ) : null}
      {notice ? <span className="hint">{notice}</span> : null}
    </section>
  );
}

export interface ChannelChoice {
  id: string;
  name: string;
  kind: string;
  routerName: string | null;
}

/**
 * The channels this router answers (PM/research/11 §5.7). Unticking a channel
 * detaches it at once (a stop: it takes no new conversations until routed
 * again); ticking one attaches it — directly while the router is a draft,
 * through approval once it is approved.
 */
export function ChannelsPanel({ routerId, name, channels, attached, canManage }: { routerId: string; name: string; channels: ChannelChoice[]; attached: string[]; canManage: boolean }) {
  const [picked, setPicked] = useState<string[]>(attached);
  const approval = useApprovalRequest();
  const router = useRouter();
  const dirty = [...picked].sort().join() !== [...attached].sort().join();
  return (
    <section className="rt-panel" aria-label="Channels">
      <h3 className="rt-h">Channels</h3>
      {channels.length === 0 ? <p className="mono-sm">No channels yet: a Tech admin adds them under Connections.</p> : null}
      <div className="checks" role="group" aria-label="Channels routed by this router">
        {channels.map((c) => (
          <label key={c.id}>
            <input type="checkbox" checked={picked.includes(c.id)} disabled={!canManage} onChange={(e) => setPicked(e.target.checked ? [...picked, c.id] : picked.filter((x) => x !== c.id))} />
            {c.name}
            {c.routerName && !attached.includes(c.id) ? <span className="mono-sm"> · now {c.routerName}</span> : null}
          </label>
        ))}
      </div>
      {canManage ? (
        <button
          type="button"
          className="btn tiny"
          disabled={!dirty || approval.pending}
          onClick={() =>
            approval.run({ objectKind: 'router', objectId: routerId, title: `Attach channels to router ${name}` }, (choice) => setRouterChannelsAction(routerId, picked, choice), { onApplied: () => router.refresh() })
          }
        >
          Save channels
        </button>
      ) : null}
      {approval.error || approval.notice ? (
        <AlertBanner tone={approval.error ? 'error' : 'info'} style={{ margin: 0 }}>
          {approval.error ?? approval.notice}
        </AlertBanner>
      ) : null}
      {approval.modal}
    </section>
  );
}

/** Disable (a stop, immediate) and delete (always a proposal). */
export function RouterActions({ routerId, name, status, canManage }: { routerId: string; name: string; status: 'DRAFT' | 'ACTIVE' | 'DISABLED'; canManage: boolean }) {
  if (!canManage) return null;
  return (
    <span className="rowsplit" style={{ gap: 6 }}>
      {status === 'ACTIVE' ? (
        <ConfirmButton label="Disable" title={`Disable router ${name}`} confirmLabel="Disable router" tone="danger" run={() => disableRouterAction(routerId)}>
          Its channels take no new conversations at once. Customers already in a conversation are not affected. Resuming needs approval.
        </ConfirmButton>
      ) : null}
      <ApprovableButton
        label="Delete"
        title={`Delete router ${name}`}
        confirmLabel="Submit for approval"
        target={{ objectKind: 'router', objectId: routerId, title: `Delete router ${name}` }}
        write={(approval) => deleteRouterAction(routerId, approval)}
        always
        tone="danger"
      >
        The router and its versions are deleted once a checker approves. Detach its channels first.
      </ApprovableButton>
    </span>
  );
}
