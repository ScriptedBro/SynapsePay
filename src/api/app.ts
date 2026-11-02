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

import { SynapseArbitrator } from '../arbitration/arbitrator.js';

export interface AppDependencies {
  config: Config;
  contractManager: ContractManager;
  arbitrator: SynapseArbitrator;
  webhookGuard: PayPalWebhookGuard;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getConsoleHtml(mode: string): string {
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
  // P1 Fix 9: Never inject master admin API key into served DOM!
  return raw
    .replace('{{PAYPAL_MODE}}', mode.toUpperCase())
    .replace('{{API_KEY}}', '');
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({
    logger: deps.config.NODE_ENV !== 'test',
  });

  // P1 Fix 9: Restrict CORS origin in production
  app.register(cors, {
    origin: deps.config.NODE_ENV === 'production'
      ? [deps.config.BASE_URL]
      : true,
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

    const html = getConsoleHtml(deps.config.PAYPAL_MODE);
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
  registerContractRoutes(app, deps.contractManager, deps.arbitrator);
  registerSubmissionRoutes(app, deps.contractManager);
  registerWebhookRoutes(app, deps.contractManager, deps.webhookGuard);

  return app;
}
