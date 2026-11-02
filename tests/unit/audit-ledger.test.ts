import { describe, it, expect } from 'vitest';
import { AuditLedger } from '../../src/core/audit-ledger.js';

describe('AuditLedger', () => {
  const secret = 'test_secret_for_audit_ledger_verification_32chars';

  it('chains entries with correct sequence and hashes', () => {
    const ledger = new AuditLedger(secret);
    const contractId = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

    const e0 = ledger.append(contractId, 'CONTRACT_CREATED', 'BUYER', { amount: 100 });
    const e1 = ledger.append(contractId, 'ESCROW_LOCKED', 'PAYPAL', { orderId: 'ORD_123' });
    const e2 = ledger.append(contractId, 'SETTLEMENT_EXECUTED', 'PAYOUTS', { payoutId: 'PAY_999' });

    expect(e0.sequence).toBe(0);
    expect(e0.previousHash).toBe('0'.repeat(64));

    expect(e1.sequence).toBe(1);
    expect(e1.previousHash).toBe(e0.currentHash);

    expect(e2.sequence).toBe(2);
    expect(e2.previousHash).toBe(e1.currentHash);

    const check = ledger.verifyIntegrity();
    expect(check.valid).toBe(true);
  });

  it('detects tampering when payload data is modified in historical records', () => {
    const ledger = new AuditLedger(secret);
    const contractId = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

    ledger.append(contractId, 'CONTRACT_CREATED', 'BUYER', { amount: 100 });
    ledger.append(contractId, 'ESCROW_LOCKED', 'PAYPAL', { orderId: 'ORD_123' });

    const history = ledger.getHistory();
    // Maliciously tamper with historical payload
    history[0]!.payload.amount = 999999;

    const tamperedLedger = new AuditLedger(secret, history);
    const check = tamperedLedger.verifyIntegrity();

    expect(check.valid).toBe(false);
    expect(check.compromisedIndex).toBe(0);
  });

  it('detects tampering when signature is forged', () => {
    const ledger = new AuditLedger(secret);
    const contractId = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

    ledger.append(contractId, 'CONTRACT_CREATED', 'BUYER', { amount: 100 });
    const history = ledger.getHistory();
    history[0]!.signature = 'forged_fake_signature_hash_here';

    const tamperedLedger = new AuditLedger(secret, history);
    const check = tamperedLedger.verifyIntegrity();

    expect(check.valid).toBe(false);
    expect(check.reason).toContain('HMAC signature invalid');
  });
});
