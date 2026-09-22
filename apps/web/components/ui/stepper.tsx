export interface Step {
  label: string;
  sub?: string;
}

export interface StepperProps {
  steps: Step[];
  /** Zero-based index of the current step; earlier steps render done. */
  current: number;
  /** Index of a failed step, if any. */
  failed?: number | undefined;
  label: string;
}

/** Vertical stepper (.stepper) used by multi-step dialogs. */
export function Stepper({ steps, current, failed, label }: StepperProps) {
  return (
    <ol className="stepper" aria-label={label} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {steps.map((step, i) => {
        const state = i === failed ? 'fail' : i < current ? 'done' : i === current ? 'now' : '';
        return (
          <li className="stp" key={step.label} aria-current={i === current ? 'step' : undefined}>
            <span className={state ? `dot ${state}` : 'dot'} aria-hidden="true">
              {i + 1}
            </span>
            <span className="st">
              <span className={i === current ? 'h now' : 'h'}>{step.label}</span>
              {step.sub ? <span className="s" style={{ display: 'block' }}>{step.sub}</span> : null}
              {state === 'done' ? <span className="sr-only"> (done)</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
