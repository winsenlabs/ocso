import { z } from 'zod';

/**
 * Host-site origins allowed to embed the web chat widget (docs/15 §1 origin
 * allowlist). Entries are bare origins — `https://shop.example.com`,
 * `http://localhost:8080` — or a single-label wildcard for subdomains,
 * `https://*.example.com`. The same list drives the widget page's CSP
 * `frame-ancestors`, the widget's postMessage origin checks and the public
 * API's `Origin` check (`originAllowed`, in the channel contract).
 */

const ORIGIN_PATTERN = /^(https?):\/\/(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

export const WebChatOrigin = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(ORIGIN_PATTERN, 'must be an origin like https://shop.example.com (no path), optionally https://*.example.com');
