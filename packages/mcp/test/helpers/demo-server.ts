import { createMeridianApp, type MeridianAuth } from '../../../../examples/mcp-bank-demo/src/app.js';
import type { MeridianStore } from '../../../../examples/mcp-bank-demo/src/store.js';
import { listen, type RunningServer } from './fixtures.js';

export interface DemoServer extends RunningServer {
  url: string;
  store: MeridianStore;
}

/** Start the external "Meridian core" demo MCP server in-process on an ephemeral port. */
export async function startDemo(
  auth: MeridianAuth | ((mcpUrl: URL) => MeridianAuth) = { mode: 'none' },
  claimsSecret?: string,
): Promise<DemoServer> {
  const running = await listen();
  const url = `${running.origin}/mcp`;
  const resolved = typeof auth === 'function' ? auth(new URL(url)) : auth;
  const { app, store } = createMeridianApp({ auth: resolved, claimsSecret });
  running.server.on('request', app);
  return { ...running, url, store };
}
