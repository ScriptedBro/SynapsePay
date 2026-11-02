import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const cleanString = (defaultVal: string) =>
  z.preprocess((val) => (typeof val === 'string' && val.trim().length > 0 ? val : defaultVal), z.string());

const cleanUrl = (defaultVal: string) =>
  z.preprocess((val) => {
    if (typeof val === 'string' && val.trim().length > 0) {
      try {
        new URL(val);
        return val;
      } catch {
        return defaultVal;
      }
    }
    return defaultVal;
  }, z.string().url());

const cleanNumber = (defaultVal: number) =>
  z.preprocess(
    (val) => (val !== undefined && val !== null && String(val).trim().length > 0 ? Number(val) : defaultVal),
    z.number()
  );

const ConfigSchema = z.object({
  PORT: cleanNumber(3000),
  HOST: cleanString('0.0.0.0'),
  NODE_ENV: z.preprocess(
    (val) => (typeof val === 'string' && ['development', 'test', 'production'].includes(val) ? val : 'production'),
    z.enum(['development', 'test', 'production'])
  ),
  API_KEY: cleanString('synapse_live_sec_prod_key_default'),
  BASE_URL: cleanUrl('http://localhost:3000'),

  // PayPal Configuration
  PAYPAL_MODE: z.preprocess(
    (val) => (typeof val === 'string' && ['sandbox', 'live'].includes(val) ? val : 'sandbox'),
    z.enum(['sandbox', 'live'])
  ),
  PAYPAL_CLIENT_ID: cleanString('mock_paypal_client_id_for_tests'),
  PAYPAL_CLIENT_SECRET: cleanString('mock_paypal_client_secret_for_tests'),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  PAYPAL_ESCROW_HOLD_CURRENCY: cleanString('USD'),
  MAX_ESCROW_AMOUNT_USD: cleanNumber(5000),
  DEFAULT_CONTRACT_TIMEOUT_SECONDS: cleanNumber(86400),

  // AI Arbitration
  OPENAI_API_KEY: z.string().optional(),
  ARBITRATION_MODEL: cleanString('gpt-4o'),
  ARBITRATION_MIN_PASS_SCORE: cleanNumber(85),

  // Security
  AUDIT_HMAC_SECRET: cleanString('default_production_hmac_secret_32_chars_min_len'),
  ARBITRATOR_PRIVATE_KEY: z.string().optional(),
  ADMIN_API_KEY: z.string().optional(),
  ENABLE_SANDBOX_ISOLATION: z.preprocess(
    (val) => (val === 'false' || val === false ? false : true),
    z.boolean()
  ),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(envOverrides?: Partial<Record<string, string>>): Config {
  const source = {
    ...process.env,
    ...envOverrides,
  };
  return ConfigSchema.parse(source);
}

export const config = loadConfig();
