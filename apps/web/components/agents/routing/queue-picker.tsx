'use client';

import { useState } from 'react';
import { updateAgentAction } from '@/lib/actions/agents';
import type { Option } from '../data/options';
import { useAgentAction } from '../shared/use-action';

/** Default handoff queue for this agent (escalation rules may target another). */
export function QueuePicker({ agentId, queues, current }: { agentId: string; queues: Option[]; current: string | null }) {
  const [value, setValue] = useState(current ?? '');
  const action = useAgentAction();
  return (
    <div className="compare" style={{ margin: '0 0 14px' }}>
      <div className="fld" style={{ minWidth: 260 }}>
        <label htmlFor="rt-queue">Default queue</label>
        <select id="rt-queue" value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">None</option>
          {queues.map((q) => (
            <option key={q.id} value={q.id}>
              {q.name}
            </option>
          ))}
        </select>
      </div>
      <button type="button" className="btn" disabled={action.pending || value === (current ?? '')} onClick={() => action.run(() => updateAgentAction(agentId, { defaultQueueId: value || null }))}>
        {action.pending ? 'Saving…' : 'Save queue'}
      </button>
      {action.error ? (
        <span className="err-text" role="alert">
          {action.error}
        </span>
      ) : null}
    </div>
  );
}
