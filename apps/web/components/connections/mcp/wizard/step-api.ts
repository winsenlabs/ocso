import type { WizardStep } from '../meta';

/** The footer's primary button submits the current step's form. */
export const STEP_FORM = 'mcp-step-form';

/** What a wizard step can do: run server actions, report, move between steps. */
export interface StepApi {
  pending: boolean;
  /** Runs a server-action task in a transition (clears the error first). */
  run: (task: () => Promise<void>) => void;
  fail: (message: string | null) => void;
  notify: (message: string | null) => void;
  go: (step: WizardStep) => void;
  /** Point the URL at a saved connection so reloads and the OAuth return resume it. */
  track: (connectionId: string, step: WizardStep) => void;
  close: () => void;
}
