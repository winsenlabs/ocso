'use client';

import posthog from 'posthog-js';
import { useEffect, useState } from 'react';

const TOKEN = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN ?? '';
const HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com';
const KEY = 'ocso-cookie-consent';
/** Fired by the footer's "Cookie settings" button to show the banner again. */
export const OPEN_CONSENT = 'ocso:cookie-settings';

type Choice = 'accepted' | 'declined';

function read(): Choice | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'accepted' || v === 'declined' ? v : null;
  } catch {
    return null;
  }
}

let started = false;
function start() {
  if (started || !TOKEN) return;
  started = true;
  posthog.init(TOKEN, {
    api_host: HOST,
    person_profiles: 'identified_only',
    capture_pageview: 'history_change',
    persistence: 'localStorage+cookie',
    // No recordings: the demo form holds people's details.
    disable_session_recording: true,
  });
}

/**
 * Analytics only with consent. Nothing loads and nothing is stored until someone presses Accept; the choice is kept
 * in this browser and can be changed from the footer. Without a PostHog token (any self-hosted build) this renders
 * nothing at all.
 */
export function Analytics() {
  const [choice, setChoice] = useState<Choice | null | undefined>(undefined);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!TOKEN) return;
    const c = read();
    setChoice(c);
    setOpen(c === null);
    if (c === 'accepted') start();
    const reopen = () => setOpen(true);
    window.addEventListener(OPEN_CONSENT, reopen);
    return () => window.removeEventListener(OPEN_CONSENT, reopen);
  }, []);

  const decide = (c: Choice) => {
    try {
      localStorage.setItem(KEY, c);
    } catch {
      /* private window: the choice lasts this visit */
    }
    setChoice(c);
    setOpen(false);
    if (c === 'accepted') {
      start();
      posthog.opt_in_capturing();
    } else if (started) {
      posthog.opt_out_capturing();
      posthog.reset();
    }
  };

  if (!TOKEN || !open) return null;
  return (
    <div role="dialog" aria-live="polite" aria-label="Cookies" className="fixed inset-x-3 bottom-3 z-[90] sm:inset-x-auto sm:bottom-5 sm:left-5 sm:max-w-sm">
      <div className="rounded-2xl border border-fg/12 bg-bg/95 p-5 text-sm text-fg/75 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.45)] backdrop-blur-xl">
        <p className="font-medium text-fg">Cookies, only with your OK</p>
        <p className="mt-2">
          We would like to use PostHog analytics, which sets cookies, to see how people use this site. Nothing is sent unless you accept.
        </p>
        <div className="mt-4 flex gap-2">
          <button type="button" onClick={() => decide('accepted')} className="flex-1 rounded-xl bg-fg px-4 py-2.5 font-medium text-bg hover:bg-fg/90">
            Accept
          </button>
          <button type="button" onClick={() => decide('declined')} className="flex-1 rounded-xl border border-fg/15 px-4 py-2.5 font-medium text-fg/80 hover:bg-fg/10">
            Decline
          </button>
        </div>
        {choice && <p className="mt-3 text-xs text-fg/45">You chose to {choice === 'accepted' ? 'accept' : 'decline'}. Change it any time.</p>}
      </div>
    </div>
  );
}

/** The footer link that reopens the banner. */
export function CookieSettings({ className }: { className?: string }) {
  if (!TOKEN) return null;
  return (
    <button type="button" onClick={() => window.dispatchEvent(new Event(OPEN_CONSENT))} className={className}>
      Cookie settings
    </button>
  );
}
