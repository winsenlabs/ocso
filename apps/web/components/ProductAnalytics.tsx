'use client';

import posthog from 'posthog-js';
import { useEffect } from 'react';

const TOKEN = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN ?? '';
const HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com';

/** Customer-facing pages never load analytics: the web chat widget is served inside other companies' sites. */
const EXCLUDED = (path: string) => path === '/chat' || path.startsWith('/chat/');

let started = false;

/**
 * Optional product analytics for a hosted demo. Off unless NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN is set at build time,
 * so self-hosted deployments send nothing anywhere. When on, it is cookieless (in-memory only), masks all text and
 * inputs, and records no sessions: it sees which screens and controls are used, never conversation content.
 */
export function ProductAnalytics() {
  useEffect(() => {
    // Read in the effect rather than with usePathname(), which would stop pages from pre-rendering.
    if (!TOKEN || started || EXCLUDED(window.location.pathname)) return;
    started = true;
    posthog.init(TOKEN, {
      api_host: HOST,
      persistence: 'memory',
      person_profiles: 'identified_only',
      capture_pageview: 'history_change',
      disable_session_recording: true,
      mask_all_text: true,
      mask_all_element_attributes: true,
      autocapture: { dom_event_allowlist: ['click', 'submit'] },
    });
  }, []);
  return null;
}
