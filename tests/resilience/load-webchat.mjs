// Load: many concurrent web chat customers, each sending messages and waiting
// for the AI reply. Reports reply latency percentiles (customer send → reply
// visible), throughput and errors. Works against a local throwaway stack
// (default) or any deployment through the public web chat API.
//
//   node tests/resilience/load-webchat.mjs --conversations 100 --messages 3 --workers 2
//   node tests/resilience/load-webchat.mjs --base-url https://support.example.com --key <channel public key>
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { openVisitor, percentile, replies, seedWebChat } from './lib/client.mjs';
import { startStack } from './lib/stack.mjs';

const { values } = parseArgs({
  options: {
    conversations: { type: 'string', default: '50' },
    messages: { type: 'string', default: '3' },
    workers: { type: 'string', default: '2' },
    latency: { type: 'string', default: '800' },
    'per-worker': { type: 'string', default: '25' },
    'base-url': { type: 'string' },
    key: { type: 'string' },
    'reply-timeout': { type: 'string', default: '60' },
  },
});
const C = Number(values.conversations);
const M = Number(values.messages);
const replyTimeoutMs = Number(values['reply-timeout']) * 1000;

let stack = null;
let baseUrl = values['base-url'];
let publicKey = values.key;
if (!baseUrl) {
  stack = await startStack({ dbName: 'ocso_load', apiPort: 4495, workers: Number(values.workers) });
  baseUrl = stack.baseUrl;
  ({ publicKey } = await seedWebChat(baseUrl, stack.setupToken, { databaseUrl: stack.databaseUrl, latencyMs: Number(values.latency), workerSettings: { conversationsPerWorker: Number(values['per-worker']) } }));
  await new Promise((r) => setTimeout(r, 4_000));
} else if (!publicKey) {
  throw new Error('--key (web chat channel public key) is required with --base-url');
}

const latencies = [];
const firstLatencies = [];
const errors = [];
let duplicates = 0;

async function customer(i) {
  const v = await openVisitor(baseUrl, publicKey);
  for (let m = 0; m < M; m++) {
    const before = replies(await v.history()).length;
    const sentAt = performance.now();
    try {
      await v.send(`load conversation ${i} message ${m}: what is my balance?`);
    } catch (err) {
      errors.push(`send: ${err.message.slice(0, 120)}`);
      continue;
    }
    let answered = false;
    while (performance.now() - sentAt < replyTimeoutMs) {
      await new Promise((r) => setTimeout(r, 300));
      const n = replies(await v.history().catch(() => ({ messages: [] }))).length;
      if (n > before) {
        latencies.push(performance.now() - sentAt);
        if (m === 0) firstLatencies.push(performance.now() - sentAt);
        if (n > before + 1) duplicates++;
        answered = true;
        break;
      }
    }
    if (!answered) errors.push(`timeout: conversation ${i} message ${m}`);
  }
}

const started = performance.now();
await Promise.all(Array.from({ length: C }, (_, i) => customer(i)));
const seconds = (performance.now() - started) / 1000;
latencies.sort((a, b) => a - b);
const fmt = (ms) => (ms === null ? '—' : `${(ms / 1000).toFixed(2)} s`);
console.log(JSON.stringify({ conversations: C, messagesEach: M, workers: stack ? Number(values.workers) : 'external', modelLatencyMs: stack ? Number(values.latency) : 'external' }));
console.log(`replies: ${latencies.length}/${C * M} · errors: ${errors.length} · duplicate replies: ${duplicates}`);
console.log(`reply latency p50 ${fmt(percentile(latencies, 50))} · p95 ${fmt(percentile(latencies, 95))} · p99 ${fmt(percentile(latencies, 99))} · max ${fmt(latencies.at(-1) ?? null)}`);
firstLatencies.sort((a, b) => a - b);
console.log(`first message of a conversation p50 ${fmt(percentile(firstLatencies, 50))} · p95 ${fmt(percentile(firstLatencies, 95))} (new conversation, cold context)`);
console.log(`throughput ${(latencies.length / seconds).toFixed(1)} replies/s over ${seconds.toFixed(1)} s`);
if (errors.length) console.log('first errors:', errors.slice(0, 5));
if (stack) {
  // Where the time went, from the turn records: waiting for a worker vs. running the turn.
  const q = `SELECT (i.seq = 1) AS first,
      round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM t.started_at - i.created_at))::numeric * 1000) AS wait_p50_ms,
      round(percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM t.started_at - i.created_at))::numeric * 1000) AS wait_p95_ms,
      round(percentile_cont(0.5) WITHIN GROUP (ORDER BY t.latency_ms)::numeric) AS turn_p50_ms,
      round(percentile_cont(0.95) WITHIN GROUP (ORDER BY t.latency_ms)::numeric) AS turn_p95_ms,
      count(*) AS turns
    FROM turns t JOIN interactions i ON i.conversation_id = t.conversation_id AND i.seq = t.seq_from
    GROUP BY 1 ORDER BY 1 DESC`;
  console.log(execFileSync('psql', [stack.databaseUrl, '-c', q], { encoding: 'utf8' }));
  const outcomes = `SELECT status, outcome, error_category, left(coalesce(error_message, ''), 80) AS error, count(*) FROM turns GROUP BY 1, 2, 3, 4 ORDER BY 5 DESC`;
  console.log(execFileSync('psql', [stack.databaseUrl, '-c', outcomes], { encoding: 'utf8' }));
  const orphans = `SELECT r.seq_from, r.lease_version AS orphan_lease, c.lease_version AS completed_lease, r.worker_id = c.worker_id AS same_worker,
      round(extract(epoch FROM c.started_at - r.started_at)::numeric, 2) AS completed_started_after_s
    FROM turns r JOIN turns c ON c.conversation_id = r.conversation_id AND c.seq_from <= r.seq_from AND c.seq_to >= r.seq_from AND c.status = 'COMPLETED'
    WHERE r.status = 'RUNNING' LIMIT 8`;
  console.log(execFileSync('psql', [stack.databaseUrl, '-c', orphans], { encoding: 'utf8' }));
  const jobs = `SELECT topic, status, max(attempts) AS max_attempts, count(*), left(max(coalesce(last_error, '')), 80) AS last_error FROM jobs GROUP BY 1, 2 ORDER BY 1, 2`;
  console.log(execFileSync('psql', [stack.databaseUrl, '-c', jobs], { encoding: 'utf8' }));
  await stack.stop();
}
process.exit(errors.length || duplicates ? 1 : 0);
