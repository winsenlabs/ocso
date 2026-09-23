import Link from 'next/link';
import { Permission, ROLE_LABELS, ROLE_PERMISSIONS, Role } from '@ocso/auth';

export interface SetupStepInput {
  key: string;
  label: string;
  done: boolean;
  href: string;
}

/** Who can do each setup step (mirrors SETUP_DOER in packages/application/src/analytics/home-needs-you-derived.ts). */
const SETUP_DOER: Record<string, Permission> = {
  model: Permission.MODEL_PROFILES_MANAGE,
  agent: Permission.AGENTS_MANAGE,
  channel: Permission.CHANNELS_MANAGE,
  second_checker: Permission.USERS_MANAGE,
  go_live: Permission.ROUTERS_MANAGE,
  ask_ocso: Permission.DEPLOYMENT_SETTINGS_MANAGE,
};

/** Presets in the order a step is handed to: the broadest role that can do it by default. */
const HANDOFF_ORDER: readonly Role[] = [Role.TECH, Role.HEAD, Role.LEAD, Role.SERVICE];

/**
 * null when this user can do the step (or the step is unknown to this web
 * build: let the page it links to decide); otherwise the role that can,
 * e.g. "Head", or "someone with access" when no preset holds the right.
 */
export function setupOwner(key: string, permissions: ReadonlySet<string>): string | null {
  const needed = SETUP_DOER[key];
  if (!needed || permissions.has(needed)) return null;
  const role = HANDOFF_ORDER.find((r) => ROLE_PERMISSIONS[r].has(needed));
  return role ? ROLE_LABELS[role] : 'someone with access';
}

/**
 * Setup checklist (HOME decision 5): on a new deployment Home shows what is
 * left to do instead of tiles with no data. Steps this user cannot do read
 * "waiting on <role>" without a link; the first open step they can do is
 * the next one.
 */
export function SetupChecklist({ steps, permissions }: { steps: SetupStepInput[]; permissions: ReadonlySet<string> }) {
  const done = steps.filter((s) => s.done).length;
  const owner = new Map(steps.map((s) => [s.key, setupOwner(s.key, permissions)]));
  const next = steps.find((s) => !s.done && owner.get(s.key) === null);
  return (
    <section className="setup-card" aria-labelledby="setup-h">
      <div className="setup-head">
        <h2 id="setup-h">Set up OCSO</h2>
        <span className="count">
          {done} of {steps.length} done
        </span>
      </div>
      <div className="setup-bar" role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={done}>
        <i style={{ width: `${steps.length ? (done / steps.length) * 100 : 0}%` }} />
      </div>
      <ol className="setup-steps">
        {steps.map((s) => {
          const waitingOn = s.done ? null : owner.get(s.key);
          return (
            <li key={s.key} className={s.done ? 'done' : s === next ? 'next' : waitingOn ? 'others' : undefined}>
              <span className="setup-check" aria-hidden="true">
                {s.done ? '✓' : ''}
              </span>
              {s.done ? (
                <span className="setup-label">
                  {s.label}
                  <span className="sr-only"> (done)</span>
                </span>
              ) : waitingOn ? (
                <span className="setup-label">
                  {s.label}
                  <span className="setup-owner mono-sm"> · waiting on {waitingOn}</span>
                </span>
              ) : (
                <Link className="setup-label" href={s.href}>
                  {s.label}
                  <span className="sr-only">{s === next ? ' (next step)' : ' (to do)'}</span>
                </Link>
              )}
              {s === next ? (
                <Link className="btn tiny accent" href={s.href} tabIndex={-1} aria-hidden="true">
                  Start
                </Link>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
