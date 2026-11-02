import { FastifyInstance } from 'fastify';
import { PayPalWebhookGuard } from '../../paypal/webhook-guard.js';
import { ContractManager } from '../../core/contract-manager.js';
import { PayPalWebhookPayloadSchema } from '../../types/paypal.js';

export function registerWebhookRoutes(
  app: FastifyInstance,
  contractManager: ContractManager,
  webhookGuard: PayPalWebhookGuard
) {
  // P0 Fix 6: Idempotent processed webhook store keyed by event.id
  const processedWebhookEvents = new Set<string>();

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

    // P0 Fix 6: Prevent replay and double-processing of identical webhook events
    if (processedWebhookEvents.has(event.id)) {
      return reply.status(200).send({
        status: 'DUPLICATE_ACKNOWLEDGED',
        eventId: event.id,
      });
    }
    processedWebhookEvents.add(event.id);

    switch (event.event_type) {
      case 'PAYMENT.AUTHORIZATION.CREATED': {
        const authResource = event.resource;
        const authId = authResource.id;
        const customId = authResource.custom_id;
        const relatedOrderId =
          authResource.supplementary_data?.related_ids?.order_id ??
          authResource.parent_payment;

        // Authoritative resolution via custom_id or indexed orderId (Fix for Claim 5)
        let contractId = customId;
        if (!contractId && relatedOrderId) {
          contractId = contractManager.getContractIdByOrderId(relatedOrderId);
        }

        if (contractId) {
          try {
            contractManager.confirmEscrowLock(contractId, authId);
          } catch {
            // Handled if already locked
          }
        }
        break;
      }

      case 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED': {
        // P0 Fix 5: Authoritatively transition to SETTLED only upon PayPal confirmation!
        const payoutResource = event.resource;
        const batchId = payoutResource.payout_batch_id;
        const itemId = payoutResource.payout_item_id || payoutResource.payout_item?.payout_item_id;

        if (batchId) {
          try {
            contractManager.confirmPayoutItemSuccess(batchId, itemId);
          } catch {}
        }
        break;
      }

      case 'PAYMENT.PAYOUTS-ITEM.FAILED':
      case 'PAYMENT.PAYOUTS-ITEM.RETURNED':
      case 'PAYMENT.PAYOUTS-ITEM.BLOCKED': {
        // P0 Fix 5: Transition to PAYOUT_FAILED when PayPal rejects or returns payment item
        const payoutResource = event.resource;
        const batchId = payoutResource.payout_batch_id;
        const itemId = payoutResource.payout_item_id || payoutResource.payout_item?.payout_item_id;
        const errorReason = payoutResource.errors?.name || payoutResource.errors?.message || 'PAYOUT_ITEM_FAILED';

        if (batchId) {
          try {
            contractManager.confirmPayoutItemFailure(batchId, itemId, errorReason);
          } catch {}
        }
        break;
      }

      case 'PAYMENT.AUTHORIZATION.VOIDED': {
        const authId = event.resource.id;
        const contractId = contractManager.getContractIdByAuthId(authId);
        if (contractId) {
          try {
            await contractManager.voidContract(contractId, 'PayPal Authorization Voided Remotely');
          } catch {}
        }
        break;
      }

      default:
        break;
    }

    return reply.status(200).send({
      status: 'ACKNOWLEDGED',
      eventId: event.id,
      eventType: event.event_type,
    });
  });
}
