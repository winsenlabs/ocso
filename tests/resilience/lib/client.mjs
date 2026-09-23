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

/**
 * Other approvable kinds the setup touches (model provider/profile, channel) go through their own approval when
 * their kind is registered and the object is not approved yet: `checker` approves, or the maker bootstraps
 * when it is the deployment's only holder of the check permission.
 */
async function ensureApproved(api, kind, objectId, maker, checker) {
  const k = (await api.get('/v1/approvals/kinds', { token: maker })).find((x) => x.kind === kind);
  if (!k) return;
  if ((await api.get(`/v1/approvals/state?objectKind=${kind}&objectId=${objectId}`, { token: maker })).approved) return;
  const action = ['ACTIVATE', 'CREATE'].find((a) => k.actions.includes(a));
  if (!action) return;
  const reason = `Resilience setup: ${kind}`;
  if (!checker) return void (await api.post('/v1/approvals', { objectKind: kind, objectId, action, bootstrap: true, reason }, { token: maker }));
  const p = await api.post('/v1/approvals', { objectKind: kind, objectId, action, checkerId: checker.id, reason }, { token: maker });
  await api.post(`/v1/approvals/${p.id}/decision`, { decision: 'APPROVE', reason, contentHash: p.contentHash }, { token: checker.token });
}

/**
 * Setup → lead → DEV_SCRIPTED provider/profile (with latency) → the lead's team → LIVE agent → active web chat
 * channel routed to the agent: channel → pass-through router → queue with the agent (PM/research/11 §5).
 * Everything goes through the real API and maker–checker: the lead is the deployment's only Head (the only
 * holder of approvals.check.agents/routing), so each approval is a recorded bootstrap self-approval.
 * `databaseUrl` is accepted for callers' compatibility and no longer used.
 */
export async function seedWebChat(baseUrl, setupToken, { latencyMs = 1500, workerSettings = {} } = {}) {
  const bootstrap = (reason) => ({ approval: { bootstrap: true, reason: `Resilience setup: ${reason}` } });
  const api = client(baseUrl);
  await api.post('/v1/setup', { setupToken, orgName: 'Resilience Test', adminName: 'Admin', adminEmail: 'admin@res.test', adminPassword: 'resilience admin 1234', timezone: 'UTC' });
  const admin = (await api.post('/v1/auth/login', { email: 'admin@res.test', password: 'resilience admin 1234' })).token;
  const leadId = (await api.post('/v1/users', { email: 'lead@res.test', name: 'Lead', role: 'HEAD', password: 'resilience lead 1234' }, { token: admin })).id;
  const lead = (await api.post('/v1/auth/login', { email: 'lead@res.test', password: 'resilience lead 1234' })).token;
  if (Object.keys(workerSettings).length) {
    // Worker settings are deployment settings under maker–checker: the lead checks when eligible, else the admin
    // (the only holder of the check permission) bootstraps; a still-draft deployment applies them directly.
    const lead0 = (await api.post('/v1/auth/login', { email: 'lead@res.test', password: 'resilience lead 1234' })).token;
    await api.patch('/v1/settings/workers', workerSettings, { token: admin }).catch(async (err) => {
      if (!String(err.message).includes('approval_required')) throw err;
      const reason = 'Resilience setup: worker settings for the run';
      const sent = await api.patch('/v1/settings/workers', { ...workerSettings, approval: { checkerId: leadId, reason } }, { token: admin }).catch((e) => {
        if (!String(e.message).includes('checker_not_eligible')) throw e;
        return api.patch('/v1/settings/workers', { ...workerSettings, approval: { bootstrap: true, reason } }, { token: admin });
      });
      if (sent?.proposal && sent.proposal.status === 'SUBMITTED') await api.post(`/v1/approvals/${sent.proposal.id}/decision`, { decision: 'APPROVE', reason, contentHash: sent.proposal.contentHash }, { token: lead0 });
    });
  }
  const provider = await api.post('/v1/model-providers', { kind: 'DEV_SCRIPTED', name: 'Scripted', enabled: false, settings: { latencyMs, chunkDelayMs: 10 }, maxConcurrency: 500 }, { token: admin });
  const providerId = provider.id ?? provider.provider?.id;
  // Platform configuration is checked by a holder of approvals.check.platform other than the admin: the Head.
  const headChecker = { id: leadId, token: lead };
  await ensureApproved(api, 'model_provider', providerId, admin, headChecker);
  const profile = await api.post('/v1/model-profiles', { name: 'support-primary', providerId, model: 'scripted', retries: 0 }, { token: admin });
  await ensureApproved(api, 'model_profile', profile.id ?? profile.profile?.id, admin, headChecker);
  // Agents are owned by teams (ADR-026); the lead who creates a team joins it.
  const team = await api.post('/v1/teams', { name: 'Support' }, { token: lead });
  const agent = await api.post('/v1/agents', { name: 'Maya', purpose: 'customer support', conversationType: 'SUPPORT', modelProfileId: profile.id ?? profile.profile?.id, teamIds: [team.id] }, { token: lead });
  // Going live is a maker–checker approval; the lead is the team's only Head, so bootstrap.
  await api.post(`/v1/agents/${agent.id}/status`, { status: 'LIVE', approval: { bootstrap: true, reason: 'Resilience setup: sole Head of the team' } }, { token: lead });
  // A draft queue with its agent, then its first approval; a draft router attached to the channel, then its activation.
  const queue = await api.post('/v1/queues', { name: 'Support', teamIds: [team.id], agentId: agent.id }, { token: lead });
  await api.post(`/v1/queues/${queue.id}/submit`, bootstrap('the support queue'), { token: lead });
  // Visitors are simulated from Node (no Origin header), like a native app.
  const settings = { auth: { allowNativeApps: true } };
  const channel = await api.post('/v1/channels', { kind: 'WEBCHAT', name: 'Web chat', status: 'ACTIVE', settings }, { token: admin }).catch(() => api.post('/v1/channels', { kind: 'WEBCHAT', name: 'Web chat', status: 'DRAFT', settings }, { token: admin }));
  // Channels are checked by a Head (approvals.check.channels): the lead checks the admin's channel.
  await ensureApproved(api, 'channel', channel.id, admin, headChecker);
  const router = await api.post('/v1/routers', { name: 'Web chat', definition: { steps: [], rules: [], fallbackQueueId: queue.id, returning: null, timeoutMinutes: 10 } }, { token: lead });
  const version = await api.post(`/v1/routers/${router.id}/versions`, { reason: 'resilience' }, { token: lead });
  await api.put(`/v1/routers/${router.id}/channels`, { channelIds: [channel.id] }, { token: lead });
  await api.post(`/v1/routers/${router.id}/activate`, { versionId: version.id, ...bootstrap('pass-through web chat router') }, { token: lead });
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
