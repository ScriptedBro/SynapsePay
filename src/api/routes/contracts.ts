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
  // Public key of the Arbitrator for offline Ed25519 verdict verification (Fix for Claim 8)
  app.get('/api/v1/arbitrator/public-key', async () => {
    return {
      algorithm: 'Ed25519',
      publicKey: arbitrator.getPublicKey(),
      description: 'Public key for offline independent verification of SynapsePay arbitration verdicts.',
    };
  });

  // Emergency Admin Kill Switch (Fix for Claim 6)
  app.post('/api/v1/admin/kill-switch', async (request, reply) => {
    const schema = z.object({ active: z.boolean() });
    const { active } = schema.parse(request.body);
    contractManager.setKillSwitch(active);
    return reply.send({ killSwitchActive: contractManager.isKillSwitchActive() });
  });

  // Sweep expired contracts
  app.post('/api/v1/admin/sweep-expired', async () => {
    return contractManager.sweepExpiredContracts();
  });

  // List all contracts, escrow records, and audit statuses
  app.get('/api/v1/contracts', async () => {
    return contractManager.listContracts();
  });

  // Create a new A2A contract and initiate PayPal escrow (Fix for Claim 14)
  app.post('/api/v1/contracts', async (request, reply) => {
    try {
      const spec = ContractSpecSchema.parse(request.body);
      const result = await contractManager.createContract(spec);
      return reply.status(201).send(result);
    } catch (err: any) {
      if (err.message?.includes('Kill switch is active')) {
        return reply.status(503).send({ error: 'SERVICE_UNAVAILABLE', message: err.message });
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

  // Worker agent accepts contract with agent identity verification (Fix for Claim 7)
  app.post('/api/v1/contracts/:id/accept', async (request, reply) => {
    const paramsSchema = z.object({ id: z.string().uuid() });
    const { id } = paramsSchema.parse(request.params);
    const worker = ParticipantSchema.parse(request.body);
    const callerAgentId = request.headers['x-agent-id'] as string | undefined;

    const result = contractManager.acceptContract(id, worker, callerAgentId);
    return reply.send(result);
  });

  // Dispute resolution endpoint (Fix for Claim 2)
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
    const result = await contractManager.voidContract(id, reason);
    return reply.send(result);
  });
}
