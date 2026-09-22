'use client';

import { AlertBanner } from '@/components/ui/alert-banner';
import type { PolicyCheck } from '@/lib/api/models';
import { TargetCachingTable, type TargetRowView } from './target-caching';

export function checkedTargets(check: PolicyCheck): TargetRowView[] {
  return [check.primary, ...check.fallbacks].map((t, i) => ({
    key: `${i}-${t.providerId}-${t.model}`,
    role: i === 0 ? 'PRIMARY' : 'FALLBACK',
    providerName: t.providerName,
    providerKind: t.providerKind,
    model: t.model,
    capabilities: t.capabilities,
    permitted: t.permitted,
    reason: t.reason,
  }));
}

/** The API's one-line summary: first sentence as the banner title (design: "Residency check passed."), the rest as its body. */
const headline = (message: string) => message.split(/(?<=\.)\s+/)[0] ?? message;
const rest = (message: string) => message.split(/(?<=\.)\s+/).slice(1).join(' ');

/** Deployment rules that decide whether a failed call may move to the next target (read-only here; edited in Settings). */
function FallbackRules({ check, categories }: { check: PolicyCheck | null; categories: string[] }) {
  const p = check?.policy;
  return (
    <div className="kv conn-kv">
      <span className="k">falls back on</span>
      <span>{categories.map((c) => c.replace(/_/g, ' ')).join(', ')} — only before any customer-visible output; validation and policy errors never fall back</span>
      <span className="k">cross-provider</span>
      <span>{p ? (p.allowCrossProviderFallback ? 'allowed' : 'not allowed') : 'validate to see the deployment policy'}</span>
      <span className="k">cross-region</span>
      <span>{p ? (p.allowCrossRegionFallback ? 'allowed' : 'not allowed') : '—'}</span>
      <span className="k">residency</span>
      <span>{p ? (p.residencyZone ? `every target must keep data in ${p.residencyZone}` : 'no residency zone required') : '—'}</span>
      <span className="k">allowlist</span>
      <span>{p ? (p.providerAllowlist.length ? `${p.providerAllowlist.length} providers allowlisted` : 'every configured provider') : '—'}</span>
    </div>
  );
}

/**
 * Result of POST /v1/model-profiles/validate for the current form: the
 * design's "Residency check passed" box, warnings about skipped fallbacks,
 * and each target's capabilities and prompt-caching behaviour.
 */
export function PolicyPanel({
  check,
  stale,
  pending,
  error,
  categories,
  cachePolicy,
  cacheTtl,
}: {
  check: PolicyCheck | null;
  stale: boolean;
  pending: boolean;
  error: string | null;
  categories: string[];
  cachePolicy: 'OFF' | 'PREFIX';
  cacheTtl: '5m' | '1h' | null;
}) {
  return (
    <section className="conn-fieldset" aria-label="Policy check" aria-busy={pending}>
      <span className="legend">Policy check · fallback rules · caching per target</span>
      <div role="status" aria-live="polite" style={{ display: 'grid', gap: 8 }}>
        {error ? (
          <AlertBanner tone="error" style={{ margin: 0 }} title="Validation could not run.">
            {error}
          </AlertBanner>
        ) : null}
        {!error && pending ? <span className="mono-sm">validating…</span> : null}
        {!error && !pending && !check ? <span className="mono-sm">Fill in the primary target to run the policy check.</span> : null}
        {!error && check ? (
          <AlertBanner tone={check.ok ? 'info' : 'error'} style={{ margin: 0 }} title={headline(check.message)}>
            {`${rest(check.message)}${stale ? ' (form changed since this check)' : ''}`.trim() || null}
          </AlertBanner>
        ) : null}
        {check?.warnings.length ? (
          <AlertBanner tone="warn" style={{ margin: 0 }}>
            {check.warnings.join(' · ')}
          </AlertBanner>
        ) : null}
      </div>
      <FallbackRules check={check} categories={categories} />
      {check ? <TargetCachingTable targets={checkedTargets(check)} cachePolicy={cachePolicy} cacheTtl={cacheTtl} /> : null}
    </section>
  );
}
