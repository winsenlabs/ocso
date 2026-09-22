/** Loaded with `node --import ./dist/instrumentation.js` (see @ocso/observability/otel). */
import { startOtel } from '@ocso/observability/otel';

await startOtel('ocso-worker');
