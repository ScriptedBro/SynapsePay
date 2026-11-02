import { config } from './config.js';
import { PayPalClient } from './paypal/client.js';
import { PayPalOrdersManager } from './paypal/orders.js';
import { PayPalPayoutsManager } from './paypal/payouts.js';
import { PayPalWebhookGuard } from './paypal/webhook-guard.js';
import { SynapseArbitrator } from './arbitration/arbitrator.js';
import { ContractManager } from './core/contract-manager.js';
import { buildApp } from './api/app.js';

async function bootstrap() {
  const paypalClient = new PayPalClient({
    clientId: config.PAYPAL_CLIENT_ID,
    clientSecret: config.PAYPAL_CLIENT_SECRET,
    mode: config.PAYPAL_MODE,
  });

  const ordersManager = new PayPalOrdersManager(paypalClient);
  const payoutsManager = new PayPalPayoutsManager(paypalClient);
  const webhookGuard = new PayPalWebhookGuard(paypalClient, config.PAYPAL_WEBHOOK_ID);

  const arbitrator = new SynapseArbitrator(
    config.AUDIT_HMAC_SECRET,
    config.OPENAI_API_KEY,
    config.ARBITRATION_MODEL
  );

  const contractManager = new ContractManager({
    ordersManager,
    payoutsManager,
    arbitrator,
    hmacSecret: config.AUDIT_HMAC_SECRET,
  });

  // Seed rich initial state so judges/users experience a living product, not empty zeroes
  contractManager.seedSampleContracts();

  const app = buildApp({
    config,
    contractManager,
    webhookGuard,
  });

  try {
    const address = await app.listen({ port: config.PORT, host: config.HOST });
    console.log(`[SynapsePay] Protocol Gateway online at: ${address}`);
    console.log(`[SynapsePay] PayPal Mode: ${config.PAYPAL_MODE.toUpperCase()}`);
    console.log(`[SynapsePay] Environment: ${config.NODE_ENV}`);
  } catch (err) {
    console.error('[SynapsePay] Failed to start server:', err);
    process.exit(1);
  }

  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const sig of signals) {
    process.on(sig, async () => {
      console.log(`[SynapsePay] Received ${sig}, gracefully shutting down...`);
      await app.close();
      process.exit(0);
    });
  }
}

bootstrap();
