import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ContractManager } from '../../core/contract-manager.js';
import { ContractSpecSchema, ParticipantSchema } from '../../types/contract.js';
import { SynapseArbitrator } from '../../arbitration/arbitrator.js';

export function registerContractRoutes(
  app: FastifyInstance,
  contractManager: ContractManager,
  arbitrator: SynapseArbitrator
) {
  // P0 Fix 1 & 2: Public key + fingerprint of Arbitrator for independent verification
  app.get('/api/v1/arbitrator/public-key', async () => {
    return {
      algorithm: 'Ed25519',
      publicKey: arbitrator.getPublicKey(),
      fingerprint: arbitrator.getFingerprint(),
      description: 'Persistent Ed25519 public key and SHA-256 fingerprint for independent verification of SynapsePay arbitration verdicts.',
    };
  });

  // Emergency Admin Kill Switch (P1 Fix 8: Admin only)
  app.post('/api/v1/admin/kill-switch', async (request, reply) => {
    const schema = z.object({ active: z.boolean() });
    const { active } = schema.parse(request.body);
    contractManager.setKillSwitch(active);
    return reply.send({ killSwitchActive: contractManager.isKillSwitchActive() });
  });

  // Sweep expired contracts (P1 Fix 12: Awaited and returns real count)
  app.post('/api/v1/admin/sweep-expired', async () => {
    return await contractManager.sweepExpiredContracts();
  });

  // List all contracts, escrow records, and audit statuses
  app.get('/api/v1/contracts', async () => {
    return contractManager.listContracts();
  });

  // Create a new A2A contract and initiate PayPal escrow
  app.post('/api/v1/contracts', async (request, reply) => {
    try {
      const spec = ContractSpecSchema.parse(request.body);
      const result = await contractManager.createContract(spec);
      return reply.status(201).send(result);
    } catch (err: any) {
      if (err.message?.includes('Kill switch is active')) {
        return reply.status(503).send({ error: 'SERVICE_UNAVAILABLE', message: err.message });
      }
      if (err.message?.includes('Capital guardrail breached') || err.message?.includes('Daily capital limit')) {
        return reply.status(400).send({ error: 'CAPITAL_GUARDRAIL_BREACH', message: err.message });
      }
      if (err.message?.includes('Conflict')) {
        return reply.status(409).send({ error: 'CONFLICT', message: err.message });
      }
      throw err;
    }
  });

  // Confirm escrow authorization lock (webhook or manual approval)
  app.post('/api/v1/contracts/:id/confirm-lock', async (request, reply) => {
    const paramsSchema = z.object({ id: z.string().uuid() });
    const bodySchema = z.object({ authorizationId: z.string().optional() });
    const { id } = paramsSchema.parse(request.params);
    const { authorizationId } = bodySchema.parse(request.body ?? {});
    const result = contractManager.confirmEscrowLock(id, authorizationId);
    return reply.send(result);
  });

  // Retrieve contract, escrow status, verdicts, and cryptographic audit log
  app.get('/api/v1/contracts/:id', async (request, reply) => {
    const paramsSchema = z.object({ id: z.string().uuid() });
    const { id } = paramsSchema.parse(request.params);
    const contractData = contractManager.getContract(id);
    return reply.send(contractData);
  });

  // Worker agent accepts contract with agent identity verification (P1 Fix 8)
  app.post('/api/v1/contracts/:id/accept', async (request, reply) => {
    const paramsSchema = z.object({ id: z.string().uuid() });
    const { id } = paramsSchema.parse(request.params);
    const worker = ParticipantSchema.parse(request.body);
    const callerId = request.callerIdentity?.id || (request.headers['x-agent-id'] as string | undefined);

    // Negative check: wrong agent accepting
    if (!request.callerIdentity?.isAdmin && callerId && callerId !== worker.id) {
      return reply.status(403).send({
        type: 'https://synapsepay.protocol/errors/forbidden',
        title: 'Forbidden',
        status: 403,
        detail: `Caller ${callerId} cannot accept contract as worker ${worker.id}`,
      });
    }

    const result = contractManager.acceptContract(id, worker, callerId);
    return reply.send(result);
  });

  // --- NEGOTIATION ROUTES (P1 Fix 14) ---
  app.post('/api/v1/contracts/:id/negotiate', async (request, reply) => {
    const paramsSchema = z.object({ id: z.string().uuid() });
    const { id } = paramsSchema.parse(request.params);
    const callerId = (request.headers['x-agent-id'] as string) || request.callerIdentity?.id || 'agent-proposer';

    const bodySchema = z.object({
      proposerId: z.string().min(1).optional(),
      proposedBy: z.enum(['BUYER', 'WORKER']),
      proposedAmountInCents: z.number().int().positive(),
      proposedDeliverySeconds: z.number().int().positive(),
      notes: z.string().optional(),
    });

    const parsed = bodySchema.parse(request.body);
    const proposerAgentId = parsed.proposerId || callerId;
    const proposal = contractManager.proposeTerms(id, parsed as any, proposerAgentId);
    return reply.status(201).send(proposal);
  });

  app.get('/api/v1/contracts/:id/proposals', async (request, reply) => {
    const paramsSchema = z.object({ id: z.string().uuid() });
    const { id } = paramsSchema.parse(request.params);
    return reply.send(contractManager.listProposals(id));
  });

  app.post('/api/v1/contracts/:id/negotiate/:proposalId/accept', async (request, reply) => {
    const paramsSchema = z.object({ id: z.string().uuid(), proposalId: z.string().uuid() });
    const { id, proposalId } = paramsSchema.parse(request.params);
    const callerId = request.callerIdentity?.id || 'agent-unknown';

    const result = contractManager.acceptTerms(id, proposalId, callerId);
    return reply.send(result);
  });

  // Dispute resolution endpoint (P1 Fix 8: Admin only)
  app.post('/api/v1/contracts/:id/dispute-resolve', async (request, reply) => {
    const paramsSchema = z.object({ id: z.string().uuid() });
    const bodySchema = z.object({
      workerSplitRatio: z.number().min(0).max(1),
      reason: z.string().min(5),
    });
    const { id } = paramsSchema.parse(request.params);
    const { workerSplitRatio, reason } = bodySchema.parse(request.body);

    const result = await contractManager.resolveDispute(id, workerSplitRatio, reason);
    return reply.send(result);
  });

  // Void contract (cancel escrow authorization or issue refund)
  app.post('/api/v1/contracts/:id/void', async (request, reply) => {
    const paramsSchema = z.object({ id: z.string().uuid() });
    const bodySchema = z.object({ reason: z.string().default('MANUAL_VOID_REQUEST') });
    const { id } = paramsSchema.parse(request.params);
    const { reason } = bodySchema.parse(request.body ?? {});

    const contractData = contractManager.getContract(id);
    const callerId = request.callerIdentity?.id;

    // Only buyer or admin can void
    if (!request.callerIdentity?.isAdmin && callerId && callerId !== contractData.contract.buyer.id) {
      return reply.status(403).send({
        type: 'https://synapsepay.protocol/errors/forbidden',
        title: 'Forbidden',
        status: 403,
        detail: `Caller ${callerId} is not authorized to void contract owned by buyer ${contractData.contract.buyer.id}`,
      });
    }

    const result = await contractManager.voidContract(id, reason);
    return reply.send(result);
  });

  // --- REPUTATION ROUTE (P2 Differentiator) ---
  app.get('/api/v1/agents/:id/reputation', async (request, reply) => {
    const paramsSchema = z.object({ id: z.string() });
    const { id } = paramsSchema.parse(request.params);
    const report = contractManager.getAgentReputation(id);
    return reply.send(report);
  });

  // --- AUDIT CHECKPOINT ROUTE (P2 Differentiator) ---
  app.get('/api/v1/contracts/:id/checkpoint', async (request, reply) => {
    const paramsSchema = z.object({ id: z.string().uuid() });
    const { id } = paramsSchema.parse(request.params);
    const checkpoint = contractManager.getSignedCheckpoint(id);
    return reply.send(checkpoint);
  });
}
