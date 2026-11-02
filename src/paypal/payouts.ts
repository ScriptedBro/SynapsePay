import { PayPalClient } from './client.js';
import { PayPalPayoutBatchRequest, PayPalPayoutBatchRequestSchema } from '../types/paypal.js';

export interface PayoutExecutionResult {
  payoutBatchId: string;
  batchStatus: string;
  senderBatchId: string;
}

export class PayPalPayoutsManager {
  constructor(private readonly client: PayPalClient) {}

  public async executeMilestonePayout(params: {
    contractId: string;
    milestoneSequence: number;
    recipientEmail: string;
    amountInCents: number;
    currency: string;
    note?: string;
  }): Promise<PayoutExecutionResult> {
    const value = (params.amountInCents / 100).toFixed(2);
    const senderBatchId = `synapse_${params.contractId.replace(/-/g, '')}_m${params.milestoneSequence}`;
    const senderItemId = `item_${params.contractId.replace(/-/g, '')}_m${params.milestoneSequence}`;

    const payload: PayPalPayoutBatchRequest = PayPalPayoutBatchRequestSchema.parse({
      sender_batch_header: {
        sender_batch_id: senderBatchId,
        email_subject: 'SynapsePay Verified Settlement: Milestone Approved',
        email_message:
          params.note ??
          `Settlement funds for milestone ${params.milestoneSequence} of contract ${params.contractId} have been disbursed by SynapsePay.`,
      },
      items: [
        {
          recipient_type: 'EMAIL',
          amount: {
            value,
            currency: params.currency,
          },
          receiver: params.recipientEmail,
          note: `Autonomous verified settlement for contract ${params.contractId}`,
          sender_item_id: senderItemId,
        },
      ],
    });

    const data = await this.client.request<any>('/v1/payments/payouts', {
      method: 'POST',
      body: payload,
    });

    return {
      payoutBatchId: data.batch_header.payout_batch_id,
      batchStatus: data.batch_header.batch_status,
      senderBatchId,
    };
  }

  public async getPayoutBatchStatus(payoutBatchId: string): Promise<any> {
    return this.client.request(`/v1/payments/payouts/${payoutBatchId}`, {
      method: 'GET',
    });
  }
}
