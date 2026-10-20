import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyPluginAsync } from 'fastify';
import { authOf } from '../../plugins/auth.js';
import { createMcpServer } from './server.js';

/**
 * Model Context Protocol endpoint (Streamable HTTP, stateless). AI assistants connect with
 * the same credentials as the REST API, e.g. an X-API-Key header.
 */
export const mcpRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.post('/mcp', { schema: { hide: true } }, async (request, reply) => {
    const server = createMcpServer({
      collections: app.collections,
      webhooks: app.webhooks,
      accountId: authOf(request).accountId,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    // The transport writes the response itself; keep the headers Fastify already set
    // (request id, rate limits) and stop Fastify from replying too.
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(name, value);
    }
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  // Stateless server: there is no event stream to open and no session to end.
  for (const method of ['GET', 'DELETE'] as const) {
    app.route({
      method,
      url: '/mcp',
      schema: { hide: true },
      handler: async (_request, reply) =>
        reply
          .status(405)
          .header('allow', 'POST')
          .send({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Method not allowed' },
            id: null,
          }),
    });
  }
};
