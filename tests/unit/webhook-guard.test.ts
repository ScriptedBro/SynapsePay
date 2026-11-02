import { describe, it, expect } from 'vitest';
import { PayPalWebhookGuard } from '../../src/paypal/webhook-guard.js';
import { PayPalClient } from '../../src/paypal/client.js';

describe('PayPalWebhookGuard', () => {
  const mockClient = new PayPalClient({
    clientId: 'test_client_id',
    clientSecret: 'test_client_secret',
    mode: 'sandbox',
  });

  const guard = new PayPalWebhookGuard(mockClient);

  it('rejects payloads missing essential PayPal headers', async () => {
    const invalidHeaders = {
      'content-type': 'application/json',
    };

    const res = await guard.verifySignature(invalidHeaders, {});
    expect(res.isValid).toBe(false);
    expect(res.reason).toContain('Missing required PayPal webhook headers');
  });

  it('rejects untrusted certificates not originating from paypal.com', async () => {
    const headers = {
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://evil-attacker.io/fake-cert.pem',
      'paypal-transmission-id': 'trans_123',
      'paypal-transmission-sig': 'sig_mock',
      'paypal-transmission-time': new Date().toISOString(),
    };

    const res = await guard.verifySignature(headers, {});
    expect(res.isValid).toBe(false);
    expect(res.reason).toContain('Untrusted cert_url hostname');
  });

  it('rejects replayed webhooks with stale timestamp (> 5 minutes)', async () => {
    const staleTime = new Date(Date.now() - 600000).toISOString(); // 10 minutes ago
    const headers = {
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123',
      'paypal-transmission-id': 'trans_123',
      'paypal-transmission-sig': 'sig_mock',
      'paypal-transmission-time': staleTime,
    };

    const res = await guard.verifySignature(headers, {});
    expect(res.isValid).toBe(false);
    expect(res.reason).toContain('Transmission timestamp expired or skewed');
  });

  it('passes security validations when headers are legitimate', async () => {
    const headers = {
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123',
      'paypal-transmission-id': 'trans_123',
      'paypal-transmission-sig': 'sig_mock',
      'paypal-transmission-time': new Date().toISOString(),
    };

    const res = await guard.verifySignature(headers, { event_type: 'PAYMENT.AUTHORIZATION.CREATED' });
    expect(res.isValid).toBe(true);
  });
});
