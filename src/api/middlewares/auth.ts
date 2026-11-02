import { FastifyRequest, FastifyReply } from 'fastify';

export function createAuthGuard(apiKey: string) {
  return async function authGuard(request: FastifyRequest, reply: FastifyReply) {
    // Webhooks have their own cryptographic signature verification; public health, info, public-key and root portal are open
    if (
      request.url.startsWith('/api/v1/webhooks/paypal') ||
      request.url === '/health' ||
      request.url === '/api/v1/info' ||
      request.url === '/api/v1/arbitrator/public-key' ||
      request.url === '/'
    ) {
      return;
    }

    const authHeader = request.headers['authorization'];
    const customHeader = request.headers['x-api-key'];

    let providedKey = '';
    if (typeof customHeader === 'string') {
      providedKey = customHeader;
    } else if (authHeader?.startsWith('Bearer ')) {
      providedKey = authHeader.substring(7).trim();
    }

    if (!providedKey || providedKey !== apiKey) {
      reply.status(401).send({
        type: 'https://synapsepay.protocol/errors/unauthorized',
        title: 'Unauthorized',
        status: 401,
        detail: 'Invalid or missing API key in Authorization or x-api-key header.',
      });
    }
  };
}
