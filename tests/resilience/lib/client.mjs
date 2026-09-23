// Minimal HTTP helpers against the OCSO API (staff routes) and the public web chat API.
export function client(baseUrl) {
  const call = async (method, path, { token, body } = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
    return json;
  };
  return { get: (p, o) => call('GET', p, o), post: (p, body, o = {}) => call('POST', p, { ...o, body }), patch: (p, body, o = {}) => call('PATCH', p, { ...o, body }), put: (p, body, o = {}) => call('PUT', p, { ...o, body }) };
}

/** Setup → lead → DEV_SCRIPTED provider/profile (with latency) → the lead's team → LIVE agent → active web chat channel. */
export async function seedWebChat(baseUrl, setupToken, { latencyMs = 1500, workerSettings = {} } = {}) {
  const api = client(baseUrl);
  await api.post('/v1/setup', { setupToken, orgName: 'Resilience Test', adminName: 'Admin', adminEmail: 'admin@res.test', adminPassword: 'resilience admin 1234', timezone: 'UTC' });
  const admin = (await api.post('/v1/auth/login', { email: 'admin@res.test', password: 'resilience admin 1234' })).token;
  await api.post('/v1/users', { email: 'lead@res.test', name: 'Lead', role: 'HEAD', password: 'resilience lead 1234' }, { token: admin });
  const lead = (await api.post('/v1/auth/login', { email: 'lead@res.test', password: 'resilience lead 1234' })).token;
  if (Object.keys(workerSettings).length) await api.patch('/v1/settings/workers', workerSettings, { token: admin });
  const provider = await api.post('/v1/model-providers', { kind: 'DEV_SCRIPTED', name: 'Scripted', settings: { latencyMs, chunkDelayMs: 10 }, maxConcurrency: 500 }, { token: admin });
  const profile = await api.post('/v1/model-profiles', { name: 'support-primary', providerId: provider.id ?? provider.provider?.id, model: 'scripted', retries: 0 }, { token: admin });
  // Agents are owned by teams (ADR-026); the lead who creates a team joins it.
  const team = await api.post('/v1/teams', { name: 'Support' }, { token: lead });
  const agent = await api.post('/v1/agents', { name: 'Maya', purpose: 'customer support', conversationType: 'SUPPORT', modelProfileId: profile.id ?? profile.profile?.id, teamIds: [team.id] }, { token: lead });
  await api.post(`/v1/agents/${agent.id}/status`, { status: 'LIVE' }, { token: lead });
  const channel = await api.post('/v1/channels', { kind: 'WEBCHAT', name: 'Web chat', status: 'ACTIVE', defaultAgentId: agent.id }, { token: admin });
  return { admin, lead, publicKey: channel.publicKey };
}

/** One customer: session + message send + history polling through the public web chat API. */
export async function openVisitor(baseUrl, publicKey) {
  const api = client(baseUrl);
  const { token } = await api.post(`/public/webchat/${publicKey}/session`, {});
  let n = 0;
  return {
    send: (text) => api.post(`/public/webchat/${publicKey}/messages`, { clientMessageId: `res-${Date.now()}-${n++}-${Math.random().toString(36).slice(2, 8)}`, text }, { token }),
    history: () => api.get(`/public/webchat/${publicKey}/messages`, { token }),
  };
}

export const replies = (history) => (history.messages ?? []).filter((m) => m.from !== 'customer');

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
