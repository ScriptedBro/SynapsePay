import { PayPalClient } from './client.js';
import { WebhookHeaders, WebhookHeadersSchema } from '../types/paypal.js';

export class PayPalWebhookGuard {
  constructor(
    private readonly client: PayPalClient,
    private readonly webhookId?: string
  ) {}

  public async verifySignature(
    rawHeaders: Record<string, string | string[] | undefined>,
    rawBody: string | Record<string, any>
  ): Promise<{ isValid: boolean; reason?: string }> {
    // 1. Normalize and extract required headers
    const normalizedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (typeof value === 'string') {
        normalizedHeaders[key.toLowerCase()] = value;
      } else if (Array.isArray(value) && value[0]) {
        normalizedHeaders[key.toLowerCase()] = value[0];
      }
    }

    const parseResult = WebhookHeadersSchema.safeParse(normalizedHeaders);
    if (!parseResult.success) {
      return {
        isValid: false,
        reason: `Missing required PayPal webhook headers: ${parseResult.error.message}`,
      };
    }

    const headers: WebhookHeaders = parseResult.data;

    // 2. Validate cert_url domain to prevent spoofing
    try {
      const parsedCertUrl = new URL(headers['paypal-cert-url']);
      if (!parsedCertUrl.hostname.endsWith('.paypal.com')) {
        return {
          isValid: false,
          reason: `Untrusted cert_url hostname: ${parsedCertUrl.hostname}`,
        };
      }
    } catch {
      return { isValid: false, reason: 'Invalid cert_url URL format' };
    }

    // 3. Check timestamp drift (5-minute max window to prevent replay attacks)
    const transmissionTime = new Date(headers['paypal-transmission-time']).getTime();
    const now = Date.now();
    if (isNaN(transmissionTime) || Math.abs(now - transmissionTime) > 300000) {
      return {
        isValid: false,
        reason: 'Transmission timestamp expired or skewed beyond 5-minute threshold',
      };
    }

    // 4. Remote signature verification via PayPal API
    const isConfiguredWebhookId = Boolean(this.webhookId && !this.webhookId.includes('your_paypal_webhook_id'));

    if (isConfiguredWebhookId) {
      try {
        const bodyObj = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
        const verificationPayload = {
          auth_algo: headers['paypal-auth-algo'],
          cert_url: headers['paypal-cert-url'],
          transmission_id: headers['paypal-transmission-id'],
          transmission_sig: headers['paypal-transmission-sig'],
          transmission_time: headers['paypal-transmission-time'],
          webhook_id: this.webhookId,
          webhook_event: bodyObj,
        };

        const res = await this.client.request<any>('/v1/notifications/verify-webhook-signature', {
          method: 'POST',
          body: verificationPayload,
        });

        if (res.verification_status === 'SUCCESS') {
          return { isValid: true };
        } else {
          return {
            isValid: false,
            reason: `PayPal remote verification returned: ${res.verification_status}`,
          };
        }
      } catch (err: any) {
        return {
          isValid: false,
          reason: `Verification request to PayPal failed: ${err.message}`,
        };
      }
    }

    // Fail closed in production when PAYPAL_WEBHOOK_ID is unconfigured to prevent spoofing
    if (process.env.NODE_ENV === 'production') {
      return {
        isValid: false,
        reason: 'PAYPAL_WEBHOOK_ID is unconfigured in production environment. Webhook verification rejected to prevent replay attacks.',
      };
    }

    // In local sandbox development/testing with missing webhook ID:
    return {
      isValid: true,
      reason: 'Sandbox local test fallback: Header checks passed (PAYPAL_WEBHOOK_ID unconfigured)',
    };
  }
}
