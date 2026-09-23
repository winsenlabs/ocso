'use client';

import { useState } from 'react';
import { classifyToolsAction } from '@/lib/actions/mcp';
import type { Connection, Tool } from '@/lib/api/mcp';
import { ToolReview, initialDecisions, type ToolDecision } from '../tool-review';
import { STEP_FORM, type StepApi } from './step-api';

/** Step 4 "Review capabilities": classify and approve tools (PUT /v1/mcp/connections/:id/tools). */
export function StepReview({ connection, tools, api }: { connection: Connection | null; tools: Tool[]; api: StepApi }) {
  // Edits override the server's current classification; tools that arrive later start from theirs.
  const [overrides, setOverrides] = useState<Record<string, ToolDecision>>({});
  const decisions = { ...initialDecisions(tools), ...overrides };
  if (!connection) return <form id={STEP_FORM} onSubmit={(e) => (e.preventDefault(), api.go('url'))} />;
  const id = connection.id;

  function submit() {
    const live = new Set(tools.filter((t) => !t.removedAt).map((t) => t.id));
    const list = Object.entries(decisions)
      .filter(([toolId]) => live.has(toolId))
      .map(([toolId, d]) => ({ toolId, ...d }));
    if (!list.length) {
      api.fail('There are no tools to approve. Re-run discovery once the server lists tools.');
      return;
    }
    if (!list.some((t) => t.approved)) {
      api.fail('Approve at least one tool; unapproved tools are never exposed.');
      return;
    }
    api.run(async () => {
      const r = await classifyToolsAction(id, list);
      if (!r.ok) api.fail(r.message);
      else {
        api.notify(`Saved classification · ${r.data.approved} tools approved.`);
        api.go('approve');
      }
    });
  }

  return (
    <ToolReview
      tools={tools}
      decisions={decisions}
      onChange={(toolId, d) => setOverrides((prev) => ({ ...prev, [toolId]: d }))}
      readOnly={false}
      formId={STEP_FORM}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    />
  );
}
