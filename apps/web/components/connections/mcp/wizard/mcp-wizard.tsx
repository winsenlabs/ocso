'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useState, useTransition } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import { Stepper } from '@/components/ui/stepper';
import type { AgentLite, Connection, Tool } from '@/lib/api/mcp';
import { connectionsHref } from '../../url';
import { STEP_NOTES, WIZARD_STEPS, stepIndex, type WizardStep } from '../meta';
import { STEP_FORM, type StepApi } from './step-api';
import { StepActive } from './step-active';
import { StepApprove } from './step-approve';
import { StepAuth } from './step-auth';
import { StepDiscover } from './step-discover';
import { StepEndpoint } from './step-endpoint';
import { StepReview } from './step-review';

interface Props {
  connection: Connection | null;
  tools: Tool[];
  agents: AgentLite[];
  initialStep: WizardStep;
  closeHref: string;
}

const NEXT_LABEL: Record<WizardStep, string> = {
  url: 'Discover server',
  discover: 'Authenticate',
  auth: 'Continue',
  review: 'Review approval',
  approve: 'Approve and connect',
  active: 'Done',
};

/**
 * "Add MCP server" (design/04): Enter URL → Discover → Authenticate → Review
 * capabilities → Approve → Active. Each step is backed by the real API; the
 * draft connection is saved at step 1, so the flow can be resumed from the
 * connections list (and after the OAuth redirect).
 */
export function McpWizard({ connection, tools, agents, initialStep, closeHref }: Props) {
  const router = useRouter();
  const [step, setStep] = useState<WizardStep>(initialStep);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const close = useCallback(() => router.replace(closeHref, { scroll: false }), [router, closeHref]);

  const api: StepApi = {
    pending,
    run: (task) => {
      setError(null);
      start(task);
    },
    fail: setError,
    notify: setNote,
    go: (next) => {
      setError(null);
      setStep(next);
    },
    track: (id, next) => router.replace(connectionsHref({ tab: 'mcp', connection: id, step: next }), { scroll: false }),
    close,
  };

  const index = stepIndex(step);
  const discovered = connection?.lastSyncAt != null;
  const steps = WIZARD_STEPS.map((s) => ({ label: s.label }));
  const failed = error ? index : undefined;
  const title = connection ? `Add MCP server · ${connection.name}` : 'Add MCP server';
  const back = () => (index === 0 ? close() : api.go(WIZARD_STEPS[index - 1]!.key));

  return (
    <Modal
      title={title}
      sub={step === 'active' ? 'Connected' : `Step ${index + 1} of 6 · ${WIZARD_STEPS[index]!.label.toLowerCase()}`}
      onClose={close}
      maxWidth={780}
      flush
      footer={
        <>
          <span className="mono-sm">{STEP_NOTES[step]}</span>
          <span className="sp" />
          <button type="button" className="btn ghost" onClick={back} disabled={pending || step === 'active'}>
            Back
          </button>
          <button type="submit" form={STEP_FORM} className="btn accent" disabled={pending}>
            {pending ? 'Working…' : step === 'discover' && connection && !discovered && connection.stage === 'DISCOVER' ? 'Retry discovery' : NEXT_LABEL[step]}
          </button>
        </>
      }
    >
      <div className="mwiz">
        <div className="sts">
          <div className="sts-inner">
            <Stepper steps={steps} current={index} failed={failed} label="Add MCP server steps" />
            <div className="hairline" />
            <span className="mono-sm">No code, no deploy. You can disable or delete the connection at any time.</span>
          </div>
        </div>
        <div className="pane">
          {error ? (
            <AlertBanner tone="error" style={{ margin: 0 }}>
              {error}
            </AlertBanner>
          ) : null}
          {note && !error ? (
            <AlertBanner style={{ margin: 0 }}>
              <span className="a-body">{note}</span>
            </AlertBanner>
          ) : null}
          {step === 'url' ? <StepEndpoint connection={connection} api={api} /> : null}
          {step === 'discover' ? <StepDiscover connection={connection} api={api} /> : null}
          {step === 'auth' ? <StepAuth connection={connection} area="connections" api={api} /> : null}
          {step === 'review' ? <StepReview connection={connection} tools={tools} api={api} /> : null}
          {step === 'approve' ? <StepApprove connection={connection} tools={tools} agents={agents} api={api} /> : null}
          {step === 'active' ? <StepActive connection={connection} tools={tools} api={api} /> : null}
        </div>
      </div>
    </Modal>
  );
}
