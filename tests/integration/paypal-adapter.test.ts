import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PayPalClient } from '../../src/paypal/client.js';
import { PayPalOrdersManager } from '../../src/paypal/orders.js';
import { PayPalPayoutsManager } from '../../src/paypal/payouts.js';

describe('PayPal Adapters (Orders, Payouts, Client)', () => {
  let client: PayPalClient;
  let ordersManager: PayPalOrdersManager;
  let payoutsManager: PayPalPayoutsManager;

  beforeEach(() => {
    client = new PayPalClient({
      clientId: 'sandbox_client_id_123',
      clientSecret: 'sandbox_secret_456',
      mode: 'sandbox',
    });

    ordersManager = new PayPalOrdersManager(client);
    payoutsManager = new PayPalPayoutsManager(client);
  });

  it('initializes client with correct sandbox base URL', () => {
    expect(client.getBaseUrl()).toBe('https://api-m.sandbox.paypal.com');
  });

  it('creates an authorization order via PayPalOrdersManager', async () => {
    const mockOrderResponse = {
      id: 'ORD_UNIT_TEST_999',
      status: 'CREATED',
      links: [
        {
          href: 'https://sandbox.paypal.com/checkoutnow?token=ORD_UNIT_TEST_999',
          rel: 'approve',
          method: 'GET',
        },
      ],
    };

    vi.spyOn(client, 'request').mockResolvedValue(mockOrderResponse);

    const res = await ordersManager.createAuthorizationOrder({
      contractId: 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380d44',
      amount: 150.0,
      currency: 'USD',
    });

    expect(res.orderId).toBe('ORD_UNIT_TEST_999');
    expect(res.status).toBe('CREATED');
    expect(res.approvalUrl).toContain('paypal.com');
  });

  it('authorizes and captures escrow orders', async () => {
    const mockAuthResponse = {
      purchase_units: [
        {
          payments: {
            authorizations: [{ id: 'AUTH_REC_123', status: 'CREATED' }],
          },
        },
      ],
    };

    const mockCaptureResponse = {
      id: 'CAP_REC_123',
      status: 'COMPLETED',
      amount: { value: '150.00', currency_code: 'USD' },
    };

    vi.spyOn(client, 'request')
      .mockResolvedValueOnce(mockAuthResponse)
      .mockResolvedValueOnce(mockCaptureResponse);

    const authRes = await ordersManager.authorizeOrder('ORD_UNIT_TEST_999');
    expect(authRes.authorizationId).toBe('AUTH_REC_123');

    const capRes = await ordersManager.captureAuthorization('AUTH_REC_123', 150.0, 'USD');
    expect(capRes.captureId).toBe('CAP_REC_123');
    expect(capRes.status).toBe('COMPLETED');
  });

  it('voids an active authorization', async () => {
    vi.spyOn(client, 'request').mockResolvedValue({});
    const res = await ordersManager.voidAuthorization('AUTH_REC_123');
    expect(res).toBe(true);
  });

  it('dispatches milestone payout via PayPalPayoutsManager', async () => {
    const mockPayoutResponse = {
      batch_header: {
        payout_batch_id: 'BATCH_MOCK_PAYOUT_123',
        batch_status: 'PENDING',
      },
    };

    vi.spyOn(client, 'request').mockResolvedValue(mockPayoutResponse);

    const res = await payoutsManager.executeMilestonePayout({
      contractId: 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380e55',
      milestoneSequence: 1,
      recipientEmail: 'agent-dev@paypal.sandbox',
      amount: 150.0,
      currency: 'USD',
    });

    expect(res.payoutBatchId).toBe('BATCH_MOCK_PAYOUT_123');
    expect(res.batchStatus).toBe('PENDING');
  });
});
