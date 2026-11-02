import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { Config } from '../config.js';
import { ContractManager } from '../core/contract-manager.js';
import { PayPalWebhookGuard } from '../paypal/webhook-guard.js';
import { createAuthGuard } from './middlewares/auth.js';
import { errorHandler } from './middlewares/error-handler.js';
import { registerContractRoutes } from './routes/contracts.js';
import { registerSubmissionRoutes } from './routes/submissions.js';
import { registerWebhookRoutes } from './routes/webhooks.js';

export interface AppDependencies {
  config: Config;
  contractManager: ContractManager;
  webhookGuard: PayPalWebhookGuard;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getConsoleHtml(mode: string, apiKey: string): string {
  const possiblePaths = [
    path.join(__dirname, 'console.html'),
    path.join(__dirname, '..', 'src', 'api', 'console.html'),
    path.join(process.cwd(), 'src', 'api', 'console.html'),
  ];
  let raw = '';
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      raw = fs.readFileSync(p, 'utf-8');
      break;
    }
  }
  return raw
    .replace('{{PAYPAL_MODE}}', mode.toUpperCase())
    .replace('{{API_KEY}}', apiKey);
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({
    logger: deps.config.NODE_ENV !== 'test',
  });

  app.register(cors, {
    origin: true,
  });

  app.setErrorHandler(errorHandler);

  // Authenticate non-webhook requests
  app.addHook('onRequest', createAuthGuard(deps.config.API_KEY));

  // Root Developer Portal & Real-Time Protocol Explorer
  app.get('/', async (request, reply) => {
    const acceptsHtml = request.headers['accept']?.includes('text/html');

    if (!acceptsHtml) {
      return {
        protocol: 'SynapsePay',
        version: '1.0.0',
        status: 'UP',
        paypalMode: deps.config.PAYPAL_MODE,
        documentation: '/api/v1/info',
      };
    }

    const html = getConsoleHtml(deps.config.PAYPAL_MODE, deps.config.API_KEY);
    return reply.type('text/html').send(html);
  });

  // Health and Info endpoints
  app.get('/health', async () => ({ status: 'UP', timestamp: new Date().toISOString() }));
  app.get('/api/v1/info', async () => ({
    protocol: 'SynapsePay',
    version: '1.0.0',
    description: 'Autonomous Agent-to-Agent Commerce & Escrow Protocol powered by PayPal',
    mode: deps.config.PAYPAL_MODE,
  }));

  // Route registration
  registerContractRoutes(app, deps.contractManager);
  registerSubmissionRoutes(app, deps.contractManager);
  registerWebhookRoutes(app, deps.contractManager, deps.webhookGuard);

  return app;
}
