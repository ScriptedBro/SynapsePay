import { FastifyRequest, FastifyReply } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    callerIdentity?: {
      id: string;
      role: 'ADMIN' | 'AGENT';
      isAdmin: boolean;
    };
  }
}

export function createAuthGuard(adminApiKey: string) {
  return async function authGuard(request: FastifyRequest, reply: FastifyReply) {
    const path = request.url.split('?')[0]!;

    // Public endpoints
    if (
      path.startsWith('/api/v1/webhooks/paypal') ||
      path === '/health' ||
      path === '/api/v1/info' ||
      path === '/api/v1/arbitrator/public-key' ||
      path.startsWith('/api/v1/agents/') && path.endsWith('/reputation') ||
      path === '/'
    ) {
      return;
    }

    const authHeader = request.headers['authorization'];
    const customHeader = request.headers['x-api-key'];
    const adminHeader = request.headers['x-admin-key'];
    const agentIdHeader = request.headers['x-agent-id'] as string | undefined;

    let providedKey = '';
    if (typeof adminHeader === 'string' && adminHeader.trim().length > 0) {
      providedKey = adminHeader.trim();
    } else if (typeof customHeader === 'string') {
      providedKey = customHeader.trim();
    } else if (authHeader?.startsWith('Bearer ')) {
      providedKey = authHeader.substring(7).trim();
    }

    if (!providedKey) {
      return reply.status(401).send({
        type: 'https://synapsepay.protocol/errors/unauthorized',
        title: 'Unauthorized',
        status: 401,
        detail: 'Invalid or missing API key in Authorization, x-api-key, or x-admin-key header.',
      });
    }

    // Determine Admin vs Agent privilege
    const isAdmin = providedKey === adminApiKey || (process.env.ADMIN_API_KEY && providedKey === process.env.ADMIN_API_KEY);

    if (isAdmin) {
      request.callerIdentity = {
        id: agentIdHeader || 'admin',
        role: 'ADMIN',
        isAdmin: true,
      };
    } else if (providedKey.startsWith('agent_') || providedKey.length >= 16) {
      // Valid Agent key
      request.callerIdentity = {
        id: agentIdHeader || providedKey,
        role: 'AGENT',
        isAdmin: false,
      };
    } else {
      return reply.status(401).send({
        type: 'https://synapsepay.protocol/errors/unauthorized',
        title: 'Unauthorized',
        status: 401,
        detail: 'API key rejected.',
      });
    }

    // P1 Fix 8: Admin route protection
    if (path.startsWith('/api/v1/admin') || path.includes('/dispute/resolve')) {
      if (!request.callerIdentity.isAdmin) {
        return reply.status(403).send({
          type: 'https://synapsepay.protocol/errors/forbidden',
          title: 'Forbidden',
          status: 403,
          detail: 'Admin privileges required for this endpoint.',
        });
      }
    }
  };
}
