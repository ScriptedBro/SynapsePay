import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { AuditEntry, AuditEntrySchema } from '../types/escrow.js';

export class AuditLedger {
  private readonly hmacSecret: string;
  private entries: AuditEntry[] = [];

  constructor(hmacSecret: string, initialEntries: AuditEntry[] = []) {
    this.hmacSecret = hmacSecret;
    this.entries = [...initialEntries];
  }

  public getHistory(): AuditEntry[] {
    return [...this.entries];
  }

  public getLatestEntry(): AuditEntry | undefined {
    return this.entries[this.entries.length - 1];
  }

  public append(contractId: string, event: string, actor: string, payload: Record<string, any>): AuditEntry {
    const latest = this.getLatestEntry();
    const sequence = latest ? latest.sequence + 1 : 0;
    const previousHash = latest ? latest.currentHash : '0'.repeat(64);
    const timestamp = new Date().toISOString();
    const id = uuidv4();

    const dataToHash = JSON.stringify({
      id,
      contractId,
      sequence,
      previousHash,
      timestamp,
      event,
      actor,
      payload,
    });

    const currentHash = crypto.createHash('sha256').update(dataToHash).digest('hex');
    const signature = crypto.createHmac('sha256', this.hmacSecret).update(currentHash).digest('hex');

    const entry: AuditEntry = AuditEntrySchema.parse({
      id,
      contractId,
      sequence,
      previousHash,
      currentHash,
      timestamp,
      event,
      actor,
      payload,
      signature,
    });

    this.entries.push(entry);
    return entry;
  }

  public verifyIntegrity(): { valid: boolean; compromisedIndex?: number; reason?: string } {
    let prevHash = '0'.repeat(64);

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;

      if (entry.sequence !== i) {
        return { valid: false, compromisedIndex: i, reason: `Invalid sequence at index ${i}` };
      }

      if (entry.previousHash !== prevHash) {
        return {
          valid: false,
          compromisedIndex: i,
          reason: `Mismatched previousHash at index ${i}: expected ${prevHash}, got ${entry.previousHash}`,
        };
      }

      const dataToHash = JSON.stringify({
        id: entry.id,
        contractId: entry.contractId,
        sequence: entry.sequence,
        previousHash: entry.previousHash,
        timestamp: entry.timestamp,
        event: entry.event,
        actor: entry.actor,
        payload: entry.payload,
      });

      const expectedHash = crypto.createHash('sha256').update(dataToHash).digest('hex');
      if (entry.currentHash !== expectedHash) {
        return { valid: false, compromisedIndex: i, reason: `Hash mismatch at index ${i}` };
      }

      const expectedSig = crypto.createHmac('sha256', this.hmacSecret).update(expectedHash).digest('hex');
      if (entry.signature !== expectedSig) {
        return { valid: false, compromisedIndex: i, reason: `HMAC signature invalid at index ${i}` };
      }

      prevHash = entry.currentHash;
    }

    return { valid: true };
  }
}
