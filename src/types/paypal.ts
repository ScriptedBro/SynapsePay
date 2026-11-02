import { z } from 'zod';

export const PayPalOrderRequestSchema = z.object({
  intent: z.enum(['AUTHORIZE', 'CAPTURE']),
  purchase_units: z.array(
    z.object({
      reference_id: z.string(),
      description: z.string().optional(),
      amount: z.object({
        currency_code: z.string(),
        value: z.string(),
      }),
    })
  ),
  application_context: z
    .object({
      brand_name: z.string().optional(),
      landing_page: z.string().optional(),
      user_action: z.string().optional(),
      return_url: z.string().url().optional(),
      cancel_url: z.string().url().optional(),
    })
    .optional(),
});

export type PayPalOrderRequest = z.infer<typeof PayPalOrderRequestSchema>;

export const PayPalPayoutItemSchema = z.object({
  recipient_type: z.enum(['EMAIL', 'PHONE', 'PAYPAL_ID']).default('EMAIL'),
  amount: z.object({
    value: z.string(),
    currency: z.string(),
  }),
  receiver: z.string(),
  note: z.string().optional(),
  sender_item_id: z.string(),
});

export type PayPalPayoutItem = z.infer<typeof PayPalPayoutItemSchema>;

export const PayPalPayoutBatchRequestSchema = z.object({
  sender_batch_header: z.object({
    sender_batch_id: z.string(),
    email_subject: z.string(),
    email_message: z.string().optional(),
  }),
  items: z.array(PayPalPayoutItemSchema),
});

export type PayPalPayoutBatchRequest = z.infer<typeof PayPalPayoutBatchRequestSchema>;

export const PayPalWebhookPayloadSchema = z.object({
  id: z.string(),
  create_time: z.string(),
  resource_type: z.string(),
  event_type: z.string(),
  summary: z.string().optional(),
  resource: z.record(z.any()),
  links: z
    .array(
      z.object({
        href: z.string(),
        rel: z.string(),
        method: z.string().optional(),
      })
    )
    .optional(),
});

export type PayPalWebhookPayload = z.infer<typeof PayPalWebhookPayloadSchema>;

export const WebhookHeadersSchema = z.object({
  'paypal-auth-algo': z.string(),
  'paypal-cert-url': z.string().url(),
  'paypal-transmission-id': z.string(),
  'paypal-transmission-sig': z.string(),
  'paypal-transmission-time': z.string(),
});

export type WebhookHeaders = z.infer<typeof WebhookHeadersSchema>;
