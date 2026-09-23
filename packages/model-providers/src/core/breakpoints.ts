import type { CacheBreakpoint, ModelMessage, SystemBlock } from '@ocso/domain';

/** Where a compiler breakpoint sits in the neutral request. */
export interface BreakpointSite {
  target: 'system' | 'message';
  index: number;
  kind: CacheBreakpoint;
}

/** Default provider limit on explicit breakpoints (Anthropic and Bedrock/Claude). */
export const DEFAULT_MAX_BREAKPOINTS = 4;

/** All breakpoint sites in prompt order: system blocks first, then messages. */
export function breakpointSites(system: readonly SystemBlock[], messages: readonly ModelMessage[]): BreakpointSite[] {
  const sites: BreakpointSite[] = [];
  system.forEach((block, index) => {
    if (block.breakpointAfter) sites.push({ target: 'system', index, kind: block.breakpointAfter });
  });
  messages.forEach((message, index) => {
    if (message.breakpointAfter && message.content.length > 0) {
      sites.push({ target: 'message', index, kind: message.breakpointAfter });
    }
  });
  return sites;
}

/**
 * Keep at most `max` sites. The earliest sites are the most widely shared
 * prefixes (agent prefix → conversation context), and the last site is the
 * longest prefix, so we keep the first `max - 1` plus the last one.
 */
export function selectBreakpoints(sites: readonly BreakpointSite[], max: number): BreakpointSite[] {
  if (max <= 0) return [];
  if (sites.length <= max) return [...sites];
  const last = sites[sites.length - 1];
  const head = sites.slice(0, max - 1);
  return last ? [...head, last] : head;
}

export const siteKey = (target: BreakpointSite['target'], index: number) => `${target}:${index}`;
