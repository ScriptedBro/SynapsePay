import { describe, it, expect, vi } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { ContractManager } from '../../src/core/contract-manager.js';
import { SynapseArbitrator } from '../../src/arbitration/arbitrator.js';
import { PayPalOrdersManager } from '../../src/paypal/orders.js';
import { PayPalPayoutsManager } from '../../src/paypal/payouts.js';
import { PayPalWebhookGuard } from '../../src/paypal/webhook-guard.js';
import { PayPalClient } from '../../src/paypal/client.js';
import { loadConfig } from '../../src/config.js';

describe('API Integration via Fastify Inject', () => {
  const config = loadConfig({
    API_KEY: 'test_sec_api_key_valid_123',
    NODE_ENV: 'test',
  });

  const mockClient = new PayPalClient({
    clientId: 'mock_client',
    clientSecret: 'mock_secret',
    mode: 'sandbox',
  });

  const ordersManager = new PayPalOrdersManager(mockClient);
  const payoutsManager = new PayPalPayoutsManager(mockClient);
  const webhookGuard = new PayPalWebhookGuard(mockClient);
  const arbitrator = new SynapseArbitrator(config.AUDIT_HMAC_SECRET);

  vi.spyOn(ordersManager, 'createAuthorizationOrder').mockResolvedValue({
    orderId: 'ORD_API_MOCK_123',
    status: 'CREATED',
    approvalUrl: 'https://sandbox.paypal.com/checkoutnow?token=ORD_API_MOCK_123',
  });

  vi.spyOn(ordersManager, 'captureAuthorization').mockResolvedValue({
    captureId: 'CAP_API_456',
    status: 'COMPLETED',
    amount: { value: '50.00', currency_code: 'USD' },
  });

  vi.spyOn(ordersManager, 'voidAuthorization').mockResolvedValue(true);

  vi.spyOn(payoutsManager, 'executeMilestonePayout').mockResolvedValue({
    payoutBatchId: 'BATCH_API_789',
    batchStatus: 'SUCCESS',
    senderBatchId: 'sender_api_123',
  });

  const contractManager = new ContractManager({
    ordersManager,
    payoutsManager,
    arbitrator,
    hmacSecret: config.AUDIT_HMAC_SECRET,
  });

  const app = buildApp({
    config,
    contractManager,
    webhookGuard,
  });

  const testContractPayload = {
    id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    buyer: {
      id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12',
      role: 'BUYER',
      name: 'Agent Buyer',
      paypalAccount: 'buyer@test.com',
    },
    totalAmount: 50,
    currency: 'USD',
    sla: {
      slaId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13',
      taskTitle: 'API Test Task',
      taskDescription: 'Generate test output',
      maxDeliverySeconds: 3600,
      maxArbitrationRetries: 1,
      minOverallScore: 70,
      deterministicChecks: [],
      semanticRubrics: [],
    },
    milestones: [
      {
        sequence: 1,
        name: 'Milestone 1',
        percentage: 100,
        amount: 50,
        currency: 'USD',
        status: 'PENDING',
      },
    ],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    metadata: {},
  };

  it('responds to health and info endpoints without auth', async () => {
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(JSON.parse(health.body).status).toBe('UP');

    const info = await app.inject({ method: 'GET', url: '/api/v1/info' });
    expect(info.statusCode).toBe(200);
    expect(JSON.parse(info.body).protocol).toBe('SynapsePay');
  });

  it('rejects protected routes when API key is missing or wrong', async () => {
    const unauth = await app.inject({
      method: 'POST',
      url: '/api/v1/contracts',
      payload: testContractPayload,
    });
    expect(unauth.statusCode).toBe(401);

    const badKey = await app.inject({
      method: 'POST',
      url: '/api/v1/contracts',
      headers: { 'x-api-key': 'wrong_key' },
      payload: testContractPayload,
    });
    expect(badKey.statusCode).toBe(401);
  });

  it('handles validation error cleanly via error-handler', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/contracts',
      headers: { 'x-api-key': config.API_KEY },
      payload: { invalid: 'payload' },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.title).toBe('Validation Error');
  });

  it('creates contract, locks escrow, accepts, submits, and retrieves status via REST', async () => {
    // 1. Create Contract
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/contracts',
      headers: { 'x-api-key': config.API_KEY },
      payload: testContractPayload,
    });

    expect(createRes.statusCode).toBe(201);
    const body = JSON.parse(createRes.body);
    expect(body.contract.id).toBe(testContractPayload.id);
    expect(body.escrow.state).toBe('ESCROW_PENDING');

    // 2. Lock escrow manually (simulating webhook)
    contractManager.confirmEscrowLock(testContractPayload.id, 'AUTH_API_123');

    // 3. Worker accepts
    const acceptRes = await app.inject({
      method: 'POST',
      url: `/api/v1/contracts/${testContractPayload.id}/accept`,
      headers: { 'x-api-key': config.API_KEY },
      payload: {
        id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380b22',
        role: 'WORKER',
        name: 'WorkerBot',
        paypalAccount: 'workerbot@test.com',
      },
    });
    expect(acceptRes.statusCode).toBe(200);

    // 4. Worker submits deliverable
    const submitRes = await app.inject({
      method: 'POST',
      url: `/api/v1/contracts/${testContractPayload.id}/submit`,
      headers: { 'x-api-key': config.API_KEY },
      payload: {
        contractId: testContractPayload.id,
        workerId: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380b22',
        milestoneSequence: 1,
        submittedAt: new Date().toISOString(),
        artifacts: [
          {
            name: 'main.py',
            type: 'CODE',
            content: 'print("hello synapse")',
          },
        ],
      },
    });
    expect(submitRes.statusCode).toBe(200);
    const submitBody = JSON.parse(submitRes.body);
    expect(submitBody.verdict.decision).toBe('RELEASE');
    expect(submitBody.escrow.state).toBe('SETTLED');

    // 5. Query contract state
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/contracts/${testContractPayload.id}`,
      headers: { 'x-api-key': config.API_KEY },
    });

    expect(getRes.statusCode).toBe(200);
    const getBody = JSON.parse(getRes.body);
    expect(getBody.escrow.state).toBe('SETTLED');
    expect(getBody.auditIntegrity.valid).toBe(true);
  });

  it('allows voiding an active contract', async () => {
    const voidContractId = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380c33';
    await app.inject({
      method: 'POST',
      url: '/api/v1/contracts',
      headers: { 'x-api-key': config.API_KEY },
      payload: { ...testContractPayload, id: voidContractId },
    });

    const voidRes = await app.inject({
      method: 'POST',
      url: `/api/v1/contracts/${voidContractId}/void`,
      headers: { 'x-api-key': config.API_KEY },
      payload: { reason: 'User requested cancellation' },
    });

    expect(voidRes.statusCode).toBe(200);
    const voidBody = JSON.parse(voidRes.body);
    expect(voidBody.state).toBe('VOIDED');
  });

  it('processes incoming PayPal webhooks with valid headers', async () => {
    const webhookPayload = {
      id: 'WH-EVT-12345',
      create_time: new Date().toISOString(),
      resource_type: 'authorization',
      event_type: 'PAYMENT.AUTHORIZATION.CREATED',
      resource: {
        id: 'AUTH_WH_999',
        custom_id: testContractPayload.id,
      },
    };

    const webhookHeaders = {
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123',
      'paypal-transmission-id': 'trans_wh_1',
      'paypal-transmission-sig': 'sig_wh_1',
      'paypal-transmission-time': new Date().toISOString(),
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/paypal',
      headers: webhookHeaders,
      payload: webhookPayload,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('ACKNOWLEDGED');
  });
});
