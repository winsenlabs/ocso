import type { ModelMessage, SystemBlock } from '@ocso/domain';
import { describe, expect, it } from 'vitest';
import { breakpointSites, selectBreakpoints } from '../../src/core/breakpoints.js';
import { buildSdkPrompt } from '../../src/core/prompt.js';
import { toSdkTools } from '../../src/core/tools.js';
import { media, standardRequest, TOOLS } from '../support/requests.js';

const marker = (kind: string) => ({ test: { kind } });

describe('buildSdkPrompt', () => {
  it('maps one system message per block and marks breakpoint sites (system block, last message part)', async () => {
    const req = standardRequest();
    const prompt = await buildSdkPrompt(req, { breakpoint: marker }, media);
    expect(prompt.instructions.map((m) => m.providerOptions)).toEqual([undefined, marker('AGENT_PREFIX'), marker('CONVERSATION_CONTEXT')]);
    const assistant = prompt.messages[1];
    expect(assistant?.role).toBe('assistant');
    expect(Array.isArray(assistant?.content) && assistant.content.at(-1)).toMatchObject({ providerOptions: marker('HISTORY') });
    expect(prompt.messages[2]).toEqual({ role: 'user', content: [{ type: 'text', text: 'What is my balance?' }] });
  });

  it('places no markers without a breakpoint builder', async () => {
    const prompt = await buildSdkPrompt(standardRequest(), {}, media);
    expect(JSON.stringify(prompt)).not.toContain('providerOptions');
    expect(prompt.markedBreakpoints).toEqual([]);
  });

  it('resolves media to bytes inside the adapter and maps tool calls/results', async () => {
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'image', blobKey: 'blob/1', mimeType: 'image/jpeg' },
          { type: 'file', blobKey: 'blob/2', mimeType: 'application/pdf', filename: 'statement.pdf' },
        ],
      },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'x', input: { a: 1 } }] },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 't1', toolName: 'x', output: { type: 'json', value: { ok: true } } },
          { type: 'tool-result', toolCallId: 't2', toolName: 'y', output: { type: 'error', value: 'denied' } },
        ],
      },
    ];
    const prompt = await buildSdkPrompt({ system: [], messages }, {}, media);
    const [user, assistant, tool] = prompt.messages;
    expect(user?.content).toEqual([
      { type: 'file', data: new TextEncoder().encode('bytes-of-blob/1'), mediaType: 'image/jpeg' },
      { type: 'file', data: new TextEncoder().encode('bytes-of-blob/2'), mediaType: 'application/pdf', filename: 'statement.pdf' },
    ]);
    expect(assistant?.content).toEqual([{ type: 'tool-call', toolCallId: 't1', toolName: 'x', input: { a: 1 } }]);
    expect(tool?.content).toEqual([
      { type: 'tool-result', toolCallId: 't1', toolName: 'x', output: { type: 'json', value: { ok: true } } },
      { type: 'tool-result', toolCallId: 't2', toolName: 'y', output: { type: 'error-text', value: 'denied' } },
    ]);
    expect(JSON.stringify(prompt)).not.toContain('blob/1"');
  });

  it('rejects misplaced parts and empty messages with validation errors', async () => {
    await expect(
      buildSdkPrompt({ system: [], messages: [{ role: 'user', content: [{ type: 'tool-call', toolCallId: 'a', toolName: 'b', input: {} }] }] }, {}, media),
    ).rejects.toMatchObject({ category: 'validation', code: 'model_message_invalid_part' });
    await expect(buildSdkPrompt({ system: [], messages: [{ role: 'user', content: [] }] }, {}, media)).rejects.toMatchObject({
      code: 'model_message_empty',
    });
  });

  it('wraps media resolver failures without leaking the underlying error', async () => {
    const failing = { resolve: () => Promise.reject(new Error('s3://secret-bucket/key denied')) };
    const messages: ModelMessage[] = [{ role: 'user', content: [{ type: 'image', blobKey: 'k', mimeType: 'image/png' }] }];
    const error = await buildSdkPrompt({ system: [], messages }, {}, failing).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'media_resolution_failed' });
    expect(JSON.stringify(error)).not.toContain('secret-bucket');
  });
});

describe('selectBreakpoints', () => {
  const system: SystemBlock[] = [
    { key: 'a', text: 'a', stable: true, breakpointAfter: 'AGENT_PREFIX' },
    { key: 'b', text: 'b', stable: false, breakpointAfter: 'CONVERSATION_CONTEXT' },
  ];
  const messages: ModelMessage[] = Array.from({ length: 5 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: [{ type: 'text', text: String(i) }],
    breakpointAfter: 'HISTORY',
  }));

  it('keeps the first max-1 sites plus the last (longest) prefix', () => {
    const sites = breakpointSites(system, messages);
    expect(sites).toHaveLength(7);
    expect(selectBreakpoints(sites, 4).map((s) => `${s.target}:${s.index}`)).toEqual(['system:0', 'system:1', 'message:0', 'message:4']);
    expect(selectBreakpoints(sites, 0)).toEqual([]);
  });
});

describe('toSdkTools', () => {
  it('builds schema-only tools in name order and rejects duplicates', () => {
    const tools = toSdkTools(TOOLS);
    expect(Object.keys(tools ?? {})).toEqual(['alpha_ping', 'core__get_balance', 'zeta_lookup']);
    for (const t of Object.values(tools ?? {})) expect(t.execute).toBeUndefined();
    expect(toSdkTools([])).toBeUndefined();
    expect(() => toSdkTools([TOOLS[0]!, TOOLS[0]!])).toThrow(/defined twice/);
  });
});
