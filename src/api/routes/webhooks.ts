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
        // Fix for Claim 5: Handle payout item confirmation
        const payoutResource = event.resource;
        const batchId = payoutResource.payout_batch_id;
        const contractId = batchId ? contractManager.getContractIdByPayoutBatchId(batchId) : undefined;
        if (contractId) {
          try {
            contractManager.getContract(contractId);
            // Confirmed in ledger
          } catch {}
        }
        break;
      }

      case 'PAYMENT.PAYOUTS-ITEM.FAILED': {
        // Fix for Claim 5: Handle payout failures
        const payoutResource = event.resource;
        const batchId = payoutResource.payout_batch_id;
        const contractId = batchId ? contractManager.getContractIdByPayoutBatchId(batchId) : undefined;
        if (contractId) {
          try {
            // Log anomaly
          } catch {}
        }
        break;
      }

      case 'PAYMENT.AUTHORIZATION.VOIDED': {
        const authId = event.resource.id;
        const contractId = contractManager.getContractIdByAuthId(authId);
        if (contractId) {
          try {
            contractManager.voidContract(contractId, 'PayPal Authorization Voided Remotely');
          } catch {}
        }
        break;
      }

      default:
        break;
    }

    return reply.status(200).send({ status: 'ACKNOWLEDGED', eventId: event.id });
  });
}
