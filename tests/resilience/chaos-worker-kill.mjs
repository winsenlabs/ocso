// Chaos: workers crash (SIGKILL) and drain (SIGTERM) while turns are in flight.
// Invariants (docs/archive/specs/10 §9, ADR-008): every customer message gets exactly one AI
// reply — no loss, no duplicates — and recovery completes within the lease /
// visibility window. Usage: node tests/resilience/chaos-worker-kill.mjs [--conversations 20]
import { parseArgs } from 'node:util';
import { openVisitor, replies, seedWebChat } from './lib/client.mjs';
import { startStack, waitFor } from './lib/stack.mjs';

const { values } = parseArgs({ options: { conversations: { type: 'string', default: '20' }, latency: { type: 'string', default: '3000' } } });
const N = Number(values.conversations);
const TURN_TIMEOUT = 20;

const stack = await startStack({ dbName: 'ocso_chaos', apiPort: 4490, workers: 2 });
let failed = false;
try {
  const { publicKey } = await seedWebChat(stack.baseUrl, stack.setupToken, {
    databaseUrl: stack.databaseUrl,
    latencyMs: Number(values.latency),
    workerSettings: { conversationsPerWorker: Math.max(10, N), turnTimeoutSeconds: TURN_TIMEOUT, leaseDurationSeconds: 10, heartbeatIntervalSeconds: 3 },
  });
  // Workers pick up new settings on their next heartbeat.
  await new Promise((r) => setTimeout(r, 4_000));

  const scenario = async (label, disrupt) => {
    const visitors = await Promise.all(Array.from({ length: N }, () => openVisitor(stack.baseUrl, publicKey)));
    const started = Date.now();
    await Promise.all(visitors.map((v, i) => v.send(`chaos ${label} message ${i}`)));
    await disrupt();
    await waitFor(async () => (await Promise.all(visitors.map(async (v) => replies(await v.history()).length))).every((n) => n >= 1), 240_000, `${label}: every conversation answered`);
    // Give a (wrongly) re-run turn time to produce a duplicate before counting.
    await new Promise((r) => setTimeout(r, 5_000));
    const counts = await Promise.all(visitors.map(async (v) => replies(await v.history()).length));
    const duplicates = counts.filter((n) => n > 1).length;
    console.log(`[${label}] ${N} conversations answered in ${((Date.now() - started) / 1000).toFixed(1)} s · duplicates: ${duplicates}`);
    if (duplicates > 0) throw new Error(`${label}: ${duplicates} conversations got more than one AI reply`);
  };

  await scenario('crash', async () => {
    await new Promise((r) => setTimeout(r, 1_000)); // turns are mid-flight (model latency)
    stack.signal('worker-0', 'SIGKILL');
    console.log('[crash] worker-0 killed with SIGKILL while turns were running');
  });

  await scenario('drain', async () => {
    stack.startWorker(2);
    await new Promise((r) => setTimeout(r, 1_000));
    const t0 = Date.now();
    stack.signal('worker-1', 'SIGTERM');
    // Nest closes the app (drain) and then re-raises SIGTERM, so a clean drain ends by that signal or with 0.
    const { code, signal } = await stack.exited('worker-1');
    console.log(`[drain] worker-1 drained and stopped in ${((Date.now() - t0) / 1000).toFixed(1)} s (${signal ?? `exit ${code}`}); worker-2 took over`);
    if (!(code === 0 || signal === 'SIGTERM')) throw new Error(`drain: worker-1 ended with ${signal ?? code}`);
  });
  console.log('chaos: PASS');
} catch (err) {
  failed = true;
  console.error('chaos: FAIL —', err instanceof Error ? err.message : err);
} finally {
  await stack.stop();
}
process.exit(failed ? 1 : 0);
