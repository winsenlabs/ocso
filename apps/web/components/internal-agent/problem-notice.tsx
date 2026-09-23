'use client';

import type { ChatProblem } from './chat-errors';
import { OcsoAvatar } from './turns';

const COPY: Record<Exclude<ChatProblem['kind'], 'not_configured' | 'failed' | 'forbidden'>, { title: string; body: string }> = {
  signed_out: { title: 'Your session has ended.', body: 'Sign in again to keep using Ask OCSO.' },
  offline: { title: 'OCSO could not be reached.', body: 'Nothing was answered. Check your connection and try again.' },
};

/** A failed request, said plainly — never a made-up answer. */
export function ProblemNotice({ problem, onRetry }: { problem: ChatProblem; onRetry: () => void }) {
  if (problem.kind === 'not_configured') return null;
  const { title, body } =
    problem.kind === 'failed'
      ? { title: problem.message, body: 'Nothing was changed.' }
      : problem.kind === 'forbidden'
        ? { title: problem.message, body: 'Ask OCSO acts with exactly your permissions.' }
        : COPY[problem.kind];
  const retryable = problem.kind === 'failed' || problem.kind === 'offline';
  return (
    <div className="aturn">
      <OcsoAvatar />
      <span className="bd">
        <div className="denied" role="alert">
          <b style={{ color: 'var(--ink-2)' }}>{title}</b> {body}
        </div>
        {retryable ? (
          <span className="rowsplit">
            <button type="button" className="btn tiny ghost" onClick={onRetry}>
              Try again
            </button>
          </span>
        ) : problem.kind === 'signed_out' ? (
          <span className="rowsplit">
            <a className="btn tiny" href="/login">
              Sign in
            </a>
          </span>
        ) : null}
      </span>
    </div>
  );
}
