import { can, type Permission, type Principal } from '@ocso/auth';
import { CAPABILITIES, capabilityAllowed, type Capability } from '../catalog/index.js';

/**
 * `get_tools` search (PM/research/12 §4): BM25 over each capability's name, summary, tags, path nouns and
 * details, with synonyms ("bot" → agent, "ticket" → conversation), over the capabilities this principal may
 * use. Capabilities the principal may not use are never returned, whatever the query.
 */

const SYNONYMS: Record<string, string[]> = {
  bot: ['agent'],
  bots: ['agent'],
  assistant: ['agent'],
  ai: ['agent'],
  ticket: ['conversation'],
  tickets: ['conversation'],
  chat: ['conversation'],
  chats: ['conversation'],
  case: ['conversation'],
  thread: ['conversation'],
  customer: ['customer', 'conversation'],
  approver: ['checker', 'approval'],
  approvers: ['checker', 'approval'],
  approve: ['approval', 'decision'],
  reject: ['approval', 'decision'],
  pending: ['approval', 'waiting'],
  waiting: ['waiting', 'queue'],
  inbox: ['conversation', 'queue'],
  staff: ['user'],
  people: ['user'],
  person: ['user'],
  colleague: ['user'],
  member: ['user', 'team'],
  employee: ['user'],
  role: ['user', 'permission'],
  rights: ['permission'],
  access: ['permission', 'user'],
  model: ['model', 'profile'],
  llm: ['model', 'provider'],
  provider: ['provider', 'model'],
  prompt: ['prompt'],
  instructions: ['prompt'],
  pause: ['status', 'pause', 'stop'],
  stop: ['status', 'pause', 'disable'],
  disable: ['disable', 'status'],
  enable: ['enable', 'status'],
  turn: ['status'],
  live: ['status', 'activate'],
  alert: ['alert'],
  alarm: ['alert'],
  incident: ['alert', 'exception'],
  sla: ['sla', 'policy'],
  latency: ['latency', 'telemetry'],
  slow: ['latency'],
  cost: ['spend', 'usage', 'pricing'],
  spend: ['spend', 'usage', 'cost'],
  worker: ['worker', 'capacity'],
  workers: ['worker', 'capacity'],
  capacity: ['worker', 'capacity'],
  settings: ['settings'],
  config: ['settings'],
  configuration: ['settings'],
  log: ['audit'],
  history: ['audit', 'changes'],
  changed: ['audit', 'changes'],
  who: ['audit', 'user'],
  mcp: ['mcp', 'connection'],
  integration: ['mcp', 'connection', 'webhook'],
  tool: ['mcp', 'tool'],
  whatsapp: ['channel'],
  email: ['channel', 'email'],
  webchat: ['channel'],
  channel: ['channel'],
  router: ['router', 'routing'],
  routing: ['router', 'queue'],
  queue: ['queue'],
  escalate: ['escalation', 'handoff'],
  escalation: ['escalation', 'handoff'],
  handoff: ['handoff', 'escalation'],
  csat: ['csat', 'quality'],
  review: ['review', 'quality'],
  attention: ['attention'],
  urgent: ['attention'],
  page: ['open', 'page'],
  open: ['open', 'page'],
  link: ['open', 'page'],
};

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'my', 'me', 'i', 'is', 'are', 'it', 'this', 'that', 'with', 'by', 'from', 'what', 'which', 'how', 'do', 'does', 'can', 'please', 'all', 'any', 'v1', 'id']);

function stem(word: string): string {
  if (word.length > 5 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

export function tokens(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}

interface Doc {
  capability: Capability;
  tf: Map<string, number>;
  length: number;
}

/** Field weights: a word in the name or tags says more than one in the developer details. */
function docOf(c: Capability): Doc {
  const words = [
    ...tokens(c.name.replace('.', ' ')).flatMap((w) => [w, w, w]),
    ...tokens(c.summary).flatMap((w) => [w, w]),
    ...c.tags.flatMap((t) => tokens(t)).flatMap((w) => [w, w]),
    ...tokens(c.path.replace(/:\w+/g, ' ')),
    ...tokens(c.details ?? ''),
  ];
  const tf = new Map<string, number>();
  for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
  return { capability: c, tf, length: words.length };
}

const DOCS: Doc[] = CAPABILITIES.map(docOf);
const AVG = DOCS.reduce((n, d) => n + d.length, 0) / Math.max(1, DOCS.length);
const DF = new Map<string, number>();
for (const d of DOCS) for (const w of d.tf.keys()) DF.set(w, (DF.get(w) ?? 0) + 1);

const K1 = 1.2;
const B = 0.75;

function expand(purpose: string): Map<string, number> {
  const q = new Map<string, number>();
  const add = (w: string, weight: number) => q.set(w, Math.max(q.get(w) ?? 0, weight));
  for (const raw of purpose.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    const w = stem(raw);
    if (!STOP.has(raw) && w.length > 1) add(w, 1);
    for (const s of SYNONYMS[raw] ?? SYNONYMS[w] ?? []) add(stem(s), 0.7);
  }
  return q;
}

const READ_HINT = /\b(list|show|what|which|who|how many|find|get|see|look|status|why|summari[sz]e|count|check)\b/i;
const WRITE_HINT = /\b(change|update|set|pause|resume|disable|enable|create|add|remove|delete|rename|assign|claim|approve|reject|turn|make|move|raise|lower|increase|decrease|revoke|grant|close|resolve|acknowledge|send|reply)\b/i;

export interface SearchHit {
  capability: Capability;
  score: number;
}

/** Whether the principal may use a capability (every listed permission, or one of them), checked with `can`. */
export function allowedFor(principal: Principal, capability: Capability): boolean {
  return capabilityAllowed(capability, (p) => can(principal, p as Permission));
}

/** Ranked capabilities for a purpose, only those the principal may use. */
export function searchCapabilities(principal: Principal, purpose: string, limit = 8): SearchHit[] {
  const query = expand(purpose);
  const wantsRead = READ_HINT.test(purpose);
  const wantsWrite = WRITE_HINT.test(purpose);
  const hits: SearchHit[] = [];
  for (const d of DOCS) {
    if (!allowedFor(principal, d.capability)) continue;
    let score = 0;
    for (const [w, weight] of query) {
      const f = d.tf.get(w);
      if (!f) continue;
      const df = DF.get(w) ?? 0;
      const idf = Math.log(1 + (DOCS.length - df + 0.5) / (df + 0.5));
      score += weight * idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.length) / AVG)));
    }
    if (score <= 0) continue;
    const isRead = d.capability.risk === 'READ';
    if (wantsWrite && !wantsRead && !isRead) score *= 1.25;
    if (wantsRead && !wantsWrite && isRead) score *= 1.15;
    hits.push({ capability: d.capability, score });
  }
  hits.sort((a, b) => b.score - a.score || a.capability.name.localeCompare(b.capability.name));
  return hits.slice(0, Math.max(1, Math.min(8, limit)));
}
