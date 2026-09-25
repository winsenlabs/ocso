import type { LanguageModelV4FunctionTool, LanguageModelV4Prompt, LanguageModelV4ToolResultOutput } from '@ai-sdk/provider';
import { plausibleArgs } from './args.js';

/**
 * Keyword-driven reply logic for the DEV-ONLY scripted model (ADR-015).
 * Pure and deterministic so end-to-end tests can rely on it.
 */

export type ScriptedTurn =
  | { kind: 'text'; text: string }
  | { kind: 'tool-call'; preface: string; toolName: string; input: Record<string, unknown> };

const HANDOFF = /\bhuman\b|agent please/i;
/** Test directive: `[[call:<tool name> {json args}]]` calls exactly that tool (exact or `__<name>` suffix match). */
const CALL_DIRECTIVE = /\[\[call:([A-Za-z0-9_.\-]+)(?:\s+(\{[\s\S]*?\}))?\]\]/;

/** Actions before lookups: "refund my last transaction" is a refund. */
const INTENTS: ReadonlyArray<{ pattern: RegExp; toolStem: string; preface: string }> = [
  { pattern: /refund/i, toolStem: 'refund', preface: 'Let me start that refund for you.' },
  { pattern: /revers(e|al)/i, toolStem: 'revers', preface: 'Let me look into reversing that.' },
  { pattern: /balance/i, toolStem: 'balance', preface: 'Let me check your balance.' },
  { pattern: /transactions?/i, toolStem: 'transaction', preface: 'Let me pull up your recent transactions.' },
];

type PromptMessage = LanguageModelV4Prompt[number];

function textOf(message: PromptMessage | undefined): string {
  if (!message || message.role === 'system') return message?.content ?? '';
  return message.content
    .map((p) => (p.type === 'text' ? p.text : ''))
    .filter(Boolean)
    .join(' ');
}

function attachmentCount(message: PromptMessage | undefined): number {
  if (!message || message.role !== 'user') return 0;
  return message.content.filter((p) => p.type === 'file').length;
}

interface ToolOutcome {
  toolName: string;
  output: LanguageModelV4ToolResultOutput;
}

function toolResultsAfter(prompt: LanguageModelV4Prompt, index: number): ToolOutcome[] {
  const outcomes: ToolOutcome[] = [];
  for (const message of prompt.slice(index + 1)) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      if (part.type === 'tool-result') outcomes.push({ toolName: part.toolName, output: part.output });
    }
  }
  return outcomes;
}

const humanize = (toolName: string) => (toolName.split('__').pop() ?? toolName).replace(/[_-]+/g, ' ');

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (value !== null && typeof value === 'object') {
    const scalars = Object.entries(value)
      .filter(([, v]) => v === null || typeof v !== 'object')
      .slice(0, 5)
      .map(([k, v]) => `${k.replace(/[_-]+/g, ' ')}: ${String(v)}`);
    const lists = Object.entries(value)
      .filter(([, v]) => Array.isArray(v))
      .map(([k, v]) => `${(v as unknown[]).length} ${k.replace(/[_-]+/g, ' ')}`);
    return [...scalars, ...lists].join(', ') || 'no details';
  }
  return String(value).slice(0, 200);
}

/**
 * What the customer should hear when a tool result carries an instruction for them (a hand-off, a transfer, an
 * action awaiting a colleague): a real model follows the instruction, so the scripted one does too instead of
 * reading the tool result back.
 */
function instructed(outcomes: readonly ToolOutcome[]): string | null {
  for (const { output } of outcomes) {
    if (output.type !== 'json' || output.value === null || typeof output.value !== 'object') continue;
    const value = output.value as Record<string, unknown>;
    if (typeof value['instruction'] !== 'string') continue;
    if (value['status'] === 'handoff_requested') return "I've asked a colleague to join. They will continue here shortly.";
    if (value['status'] === 'transfer_requested') return `A colleague from ${typeof value['queue'] === 'string' ? value['queue'] : 'the right team'} will take it from here.`;
    if (value['status'] === 'awaiting_human_confirmation') return 'A colleague needs to confirm this. They will confirm it here shortly.';
  }
  return null;
}

function summarize(outcomes: readonly ToolOutcome[]): string {
  const followed = instructed(outcomes);
  if (followed) return followed;
  const lines = outcomes.map(({ toolName, output }) => {
    const name = humanize(toolName);
    if (output.type === 'error-text' || output.type === 'error-json') return `${name} did not go through (${describeValue(output.value)}).`;
    if (output.type === 'execution-denied') return `${name} was not permitted.`;
    if (output.type === 'text' || output.type === 'json') return `${name}: ${describeValue(output.value)}.`;
    return `${name}: done.`;
  });
  const failed = outcomes.some((o) => o.output.type !== 'text' && o.output.type !== 'json');
  const close = failed ? "I'm sorry about that — would you like me to connect you with a colleague?" : 'Is there anything else I can help with?';
  return `Here's what I found. ${lines.join(' ')} ${close}`;
}

function echo(text: string, attachments: number): string {
  const said = text.trim().replace(/\s+/g, ' ').slice(0, 280);
  const files = attachments > 0 ? ` I received ${attachments} attachment${attachments === 1 ? '' : 's'}.` : '';
  return (
    `Thanks for reaching out! You said: "${said}".${files} ` +
    "(I'm OCSO's development scripted model: I can echo messages and demo tool calls — " +
    'try asking about your balance, transactions, a refund, or ask for a human; tests can force a tool with [[call:<tool> {json}]].)'
  );
}

export function scriptReply(prompt: LanguageModelV4Prompt, tools: readonly LanguageModelV4FunctionTool[]): ScriptedTurn {
  let userIndex = -1;
  prompt.forEach((m, i) => {
    if (m.role === 'user') userIndex = i;
  });
  const user = prompt[userIndex];
  const outcomes = toolResultsAfter(prompt, userIndex);
  if (outcomes.length > 0) return { kind: 'text', text: summarize(outcomes) };

  const text = textOf(user);
  const directive = CALL_DIRECTIVE.exec(text);
  if (directive) {
    const wanted = directive[1]!;
    const tool = tools.find((t) => t.name === wanted) ?? tools.find((t) => t.name.endsWith(`__${wanted}`));
    if (!tool) return { kind: 'text', text: `No tool named ${wanted} is available to me.` };
    let input: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = directive[2] ? JSON.parse(directive[2]) : null;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
    } catch {
      input = null;
    }
    return { kind: 'tool-call', preface: `Calling ${humanize(tool.name)}.`, toolName: tool.name, input: input ?? plausibleArgs(tool.inputSchema, text) };
  }
  if (HANDOFF.test(text)) {
    const handoff = tools.find((t) => t.name.endsWith('request_handoff'));
    if (handoff) {
      return {
        kind: 'tool-call',
        preface: "Of course — I'll connect you with a colleague.",
        toolName: handoff.name,
        input: plausibleArgs(handoff.inputSchema, `Customer asked for a human: ${text}`),
      };
    }
    return { kind: 'text', text: "I'd connect you with a colleague, but handoff isn't available here." };
  }
  for (const intent of INTENTS) {
    if (!intent.pattern.test(text)) continue;
    const tool = tools.find((t) => t.name.toLowerCase().includes(intent.toolStem));
    if (tool) {
      return { kind: 'tool-call', preface: intent.preface, toolName: tool.name, input: plausibleArgs(tool.inputSchema, text) };
    }
  }
  return { kind: 'text', text: echo(text, attachmentCount(user)) };
}
