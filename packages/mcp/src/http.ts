import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer, type McpServerOptions } from './server.js';

/**
 * Answer one MCP request over HTTP (Streamable HTTP, stateless: no session, JSON replies). The
 * caller has already checked who is asking. A fresh server per request is cheap and keeps no
 * state between calls; the engine and its open projects are what is shared.
 */
export async function serveMcpHttp(
  opts: McpServerOptions,
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
): Promise<void> {
  const server = createMcpServer(opts);
  // No session id generator: stateless mode.
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  // The SDK's optional fields are typed loosely for `exactOptionalPropertyTypes`.
  await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
  await transport.handleRequest(req, res, body);
}
