import type { Readable, Writable } from 'node:stream';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

/**
 * Serve over stdio until the client goes away (stdin ends) or the server is closed.
 * stdout belongs to the protocol: log to stderr only.
 */
export async function serveStdio(
  server: Server,
  stdin: Readable = process.stdin,
  stdout: Writable = process.stdout,
): Promise<void> {
  const closed = new Promise<void>((resolve) => {
    server.onclose = () => resolve();
  });
  await server.connect(new StdioServerTransport(stdin, stdout));
  stdin.once('end', () => void server.close());
  stdin.once('close', () => void server.close());
  await closed;
}
