/**
 * Trace deep links (docs/11 §5). The template comes from configuration
 * (OCSO_TRACE_URL_TEMPLATE, e.g. `http://localhost:16686/trace/{traceId}`); the
 * trace id is URL-encoded and must look like a W3C/OTel trace id.
 */
const TRACE_ID = /^[0-9a-fA-F]{16,32}$/;

export function traceUrl(template: string | null | undefined, traceId: string | null | undefined): string | null {
  if (!template || !traceId || !TRACE_ID.test(traceId) || !template.includes('{traceId}')) return null;
  return template.replaceAll('{traceId}', encodeURIComponent(traceId));
}
