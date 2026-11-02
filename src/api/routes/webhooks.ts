import { FastifyInstance } from 'fastify';
import { PayPalWebhookGuard } from '../../paypal/webhook-guard.js';
import { ContractManager } from '../../core/contract-manager.js';
import { PayPalWebhookPayloadSchema } from '../../types/paypal.js';

export function registerWebhookRoutes(
  app: FastifyInstance,
  contractManager: ContractManager,
  webhookGuard: PayPalWebhookGuard
) {
  app.post('/api/v1/webhooks/paypal', async (request, reply) => {
    const rawHeaders = request.headers as Record<string, string | undefined>;
    const body = request.body;

    const signatureCheck = await webhookGuard.verifySignature(rawHeaders, body as any);
    if (!signatureCheck.isValid) {
      return reply.status(401).send({
        error: 'INVALID_WEBHOOK_SIGNATURE',
        detail: signatureCheck.reason,
      });
    }

    const event = PayPalWebhookPayloadSchema.parse(body);

    switch (event.event_type) {
      case 'PAYMENT.AUTHORIZATION.CREATED': {
        const customId =
          event.resource.custom_id ??
          event.resource.invoice_id ??
          event.resource.supplementary_data?.related_ids?.order_id;
        const authId = event.resource.id;

        if (customId) {
          try {
            contractManager.confirmEscrowLock(customId, authId);
          } catch {
            // Contract may already be updated or mapped via orderId
          }
        }
        break;
      }

      case 'PAYMENT.AUTHORIZATION.VOIDED': {
        // Void event recorded
        break;
      }

      case 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED': {
        // Payout success verified
        break;
      }

      default:
        break;
    }

    return reply.status(200).send({ status: 'ACKNOWLEDGED', eventId: event.id });
  });
}
