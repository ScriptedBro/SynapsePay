import { PayPalClient } from './client.js';

export interface CreateOrderResult {
  orderId: string;
  status: string;
  approvalUrl?: string;
}

export interface CaptureResult {
  captureId: string;
  status: string;
  amount: { value: string; currency_code: string };
}

export interface RefundResult {
  refundId: string;
  status: string;
  amount: { value: string; currency_code: string };
}

export class PayPalOrdersManager {
  constructor(private readonly client: PayPalClient) {}

  public async createAuthorizationOrder(params: {
    contractId: string;
    amountInCents: number;
    currency: string;
    returnUrl?: string;
    cancelUrl?: string;
    requestId?: string;
  }): Promise<CreateOrderResult> {
    const value = (params.amountInCents / 100).toFixed(2);

    const payload = {
      intent: 'AUTHORIZE',
      purchase_units: [
        {
          reference_id: params.contractId,
          custom_id: params.contractId, // Authoritative index for Webhook mapping
          description: `SynapsePay Escrow Hold for Contract ${params.contractId}`,
          amount: {
            currency_code: params.currency,
            value,
          },
        },
      ],
      application_context: {
        brand_name: 'SynapsePay Autonomous Settlement',
        landing_page: 'NO_PREFERENCE',
        user_action: 'CONTINUE',
        return_url: params.returnUrl ?? 'https://synapsepay.protocol/escrow/approved',
        cancel_url: params.cancelUrl ?? 'https://synapsepay.protocol/escrow/cancelled',
      },
    };

    // P0 Fix 6: Deterministic idempotency request ID
    const requestId = params.requestId ?? `order_${params.contractId}`;

    const data = await this.client.request<any>('/v2/checkout/orders', {
      method: 'POST',
      body: payload,
      headers: {
        'PayPal-Request-Id': requestId,
      },
    });

    const approvalLink = data.links?.find((link: any) => link.rel === 'approve');

    return {
      orderId: data.id,
      status: data.status,
      approvalUrl: approvalLink?.href,
    };
  }

  public async getOrderDetails(orderId: string): Promise<any> {
    return this.client.request(`/v2/checkout/orders/${orderId}`, {
      method: 'GET',
    });
  }

  public async authorizeOrder(orderId: string): Promise<{ authorizationId: string; status: string }> {
    const data = await this.client.request<any>(`/v2/checkout/orders/${orderId}/authorize`, {
      method: 'POST',
      headers: {
        'PayPal-Request-Id': `auth_${orderId}`,
      },
    });

    const authorization = data.purchase_units?.[0]?.payments?.authorizations?.[0];
    if (!authorization) {
      throw new Error(`Failed to extract authorization from order ${orderId}: ${JSON.stringify(data)}`);
    }

    return {
      authorizationId: authorization.id,
      status: authorization.status,
    };
  }

  public async captureAuthorization(
    authorizationId: string,
    amountInCents: number,
    currency: string,
    isFinalCapture: boolean = true,
    requestId?: string
  ): Promise<CaptureResult> {
    const value = (amountInCents / 100).toFixed(2);

    const payload = {
      amount: {
        value,
        currency_code: currency,
      },
      is_final_capture: isFinalCapture,
    };

    // P0 Fix 6: Deterministic idempotency key per capture attempt
    const finalRequestId = requestId ?? `cap_${authorizationId}_${amountInCents}_${isFinalCapture}`;

    const data = await this.client.request<any>(
      `/v2/payments/authorizations/${authorizationId}/capture`,
      {
        method: 'POST',
        body: payload,
        headers: {
          'PayPal-Request-Id': finalRequestId,
        },
      }
    );

    return {
      captureId: data.id,
      status: data.status,
      amount: data.amount,
    };
  }

  public async refundCapture(
    captureId: string,
    amountInCents?: number,
    currency?: string,
    note?: string,
    requestId?: string
  ): Promise<RefundResult> {
    const payload: any = {};
    if (amountInCents !== undefined && currency) {
      payload.amount = {
        value: (amountInCents / 100).toFixed(2),
        currency_code: currency,
      };
    }
    if (note) {
      payload.note_to_payer = note;
    }

    // P0 Fix 6: Deterministic refund idempotency key
    const finalRequestId = requestId ?? `ref_${captureId}_${amountInCents ?? 'full'}`;

    const data = await this.client.request<any>(
      `/v2/payments/captures/${captureId}/refund`,
      {
        method: 'POST',
        body: Object.keys(payload).length > 0 ? payload : undefined,
        headers: {
          'PayPal-Request-Id': finalRequestId,
        },
      }
    );

    return {
      refundId: data.id,
      status: data.status,
      amount: data.amount,
    };
  }

  public async voidAuthorization(authorizationId: string, requestId?: string): Promise<boolean> {
    // P0 Fix 6: Deterministic void idempotency key
    const finalRequestId = requestId ?? `void_${authorizationId}`;

    await this.client.request(`/v2/payments/authorizations/${authorizationId}/void`, {
      method: 'POST',
      headers: {
        'PayPal-Request-Id': finalRequestId,
      },
    });
    return true;
  }
}
