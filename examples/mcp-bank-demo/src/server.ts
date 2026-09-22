import { McpServer } from '@modelcontextprotocol/server';
import type { RequestContext } from './request-context.js';
import type { MeridianStore } from './store.js';
import { registerActionTools } from './tools/action-tools.js';
import { registerCustomerTools } from './tools/customer-tools.js';
import { registerLedgerTools } from './tools/ledger-tools.js';

export const SERVER_INFO = { name: 'meridian-core', version: '0.1.0' } as const;

/**
 * One McpServer per HTTP request (stateless), sharing the long-lived store.
 * The same factory serves 2026-07-28 and 2025-era clients via createMcpHandler.
 */
export function buildMeridianServer(store: MeridianStore, ctx: RequestContext): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: 'Meridian core banking demo: customer, card ledger, EMI, statements, disputes, reversals and policy search.',
  });
  registerCustomerTools(server, store, ctx);
  registerLedgerTools(server, store, ctx);
  registerActionTools(server, store, ctx);
  return server;
}
