'use client';

import { useState } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { KeyValue } from '@/components/ui/key-value';
import { createAndDiscoverAction } from '@/lib/actions/mcp';
import type { Connection } from '@/lib/api/mcp';
import { Input } from '../../profiles/profile-fields';
import { scopeLabel } from '../meta';
import { STEP_FORM, type StepApi } from './step-api';

const NAME = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

/** Step 1 "Enter URL": save a draft (egress-checked by the API), then discover. */
export function StepEndpoint({ connection, api }: { connection: Connection | null; api: StepApi }) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [network, setNetwork] = useState<'INTERNAL' | 'PUBLIC'>('INTERNAL');
  const [scope, setScope] = useState<'SHARED' | 'USER'>('SHARED');
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (connection) {
    return (
      <form id={STEP_FORM} onSubmit={(e) => (e.preventDefault(), api.go('discover'))} style={{ display: 'grid', gap: 12 }}>
        <KeyValue
          items={[
            { k: 'connection', v: connection.name },
            { k: 'server url', v: <span className="mono-sm">{connection.url}</span> },
            { k: 'network', v: connection.network === 'INTERNAL' ? 'internal (allowlisted private host)' : 'public internet' },
            { k: 'scope', v: scopeLabel(connection.kind) },
          ]}
        />
        <span className="mono-sm">The draft is saved. To change the URL or scope, delete it and add the server again.</span>
      </form>
    );
  }

  function submit() {
    const next: Record<string, string> = {};
    if (!url.trim()) next['url'] = 'Enter the MCP server URL';
    else if (!/^https?:\/\//i.test(url.trim())) next['url'] = 'Use https:// (http:// only for allowlisted internal hosts)';
    if (!NAME.test(name.trim())) next['name'] = 'Lower-case letters, digits and dashes, 2–40 characters (it prefixes tool names)';
    setErrors(next);
    if (Object.keys(next).length) return;
    api.run(async () => {
      const r = await createAndDiscoverAction({ url: url.trim(), name: name.trim(), description: description.trim(), network, scope });
      if (!r.ok) {
        api.fail(r.message);
        return;
      }
      api.track(r.data.connectionId, 'discover');
      api.go('discover');
      if (r.data.outcome === 'FAILED') api.fail(`Draft saved, but discovery failed: ${r.data.message}`);
      else api.notify(r.data.message);
    });
  }

  return (
    <form id={STEP_FORM} noValidate onSubmit={(e) => (e.preventDefault(), submit())} style={{ display: 'grid', gap: 14 }}>
      <Input
        id="mcp-url"
        label="MCP server URL"
        value={url}
        onChange={setUrl}
        error={errors['url']}
        hint="streamable HTTP endpoint · OCSO reads the capability list only"
      />
      <div className="fld-row">
        <Input id="mcp-name" label="Connection name" value={name} onChange={setName} error={errors['name']} hint="how agents, tool names and audit logs refer to it" />
        <Input id="mcp-desc" label="Description (optional)" value={description} onChange={setDescription} />
      </div>
      <div className="fld-row">
        <div className="fld">
          <label htmlFor="mcp-network">Network</label>
          <select id="mcp-network" value={network} onChange={(e) => setNetwork(e.target.value as 'INTERNAL' | 'PUBLIC')}>
            <option value="INTERNAL">Internal (private host on the egress allowlist)</option>
            <option value="PUBLIC">Public internet (https only)</option>
          </select>
        </div>
        <div className="fld">
          <label htmlFor="mcp-scope">Connection scope</label>
          <select id="mcp-scope" value={scope} onChange={(e) => setScope(e.target.value as 'SHARED' | 'USER')}>
            <option value="SHARED">Shared — available subject to policy</option>
            <option value="USER">User-scoped — each user connects their own account</option>
          </select>
        </div>
      </div>
      <AlertBanner style={{ margin: 0 }}>
        <span className="a-body">
          OCSO saves a draft and checks the URL against the egress policy before any request; private addresses are refused unless an
          administrator allowlisted the host.
        </span>
      </AlertBanner>
    </form>
  );
}
