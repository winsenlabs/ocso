import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node';
import { McpServer as V1McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport as V1Transport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { listen, type RunningServer } from './fixtures.js';

export interface McpTestServer extends RunningServer {
  url: string;
}

/** A 2026-capable (v2) server built per request from `register`, on an ephemeral port, no auth. */
export async function startV2Server(register: (server: McpServer) => void): Promise<McpTestServer> {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'test-v2', version: '1.0.0' });
    register(server);
    return server;
  });
  const node = toNodeHandler(handler);
  const running = await listen((req, res) => {
    // Node's IncomingMessage predates exactOptionalPropertyTypes; structurally it is the expected shape.
    void node(req as NodeIncomingMessageLike, res);
  });
  return { ...running, url: `${running.origin}/mcp` };
}

/** A 2025-era server (legacy v1 SDK, stateless Streamable HTTP): speaks only the initialize handshake. */
export async function startLegacyServer(): Promise<McpTestServer> {
  const running = await listen((req, res) => {
    const server = new V1McpServer({ name: 'legacy-2025', version: '1.30.0' });
    server.registerTool(
      'lookup',
      { description: 'Legacy lookup', inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
      async ({ id }) => ({ content: [{ type: 'text', text: `legacy:${id}` }] }),
    );
    // Legacy v1 SDK typings predate exactOptionalPropertyTypes (stateless = explicit undefined generator).
    const transport = new V1Transport({ sessionIdGenerator: undefined } as unknown as ConstructorParameters<typeof V1Transport>[0]);
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    void server.connect(transport as unknown as Parameters<V1McpServer['connect']>[0]).then(() => transport.handleRequest(req, res));
  });
  return { ...running, url: `${running.origin}/mcp` };
}

/** Minimal HTTP server answering every request with a fixed status (for 5xx / non-MCP cases). */
export async function startStatusServer(status: number): Promise<McpTestServer> {
  const running = await listen((_req, res) => {
    res.writeHead(status, { 'content-type': 'text/plain' }).end('upstream exploded: stack trace with secrets');
  });
  return { ...running, url: `${running.origin}/mcp` };
}
