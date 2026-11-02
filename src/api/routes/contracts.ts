import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ContractManager } from '../../core/contract-manager.js';
import { ContractSpecSchema, ParticipantSchema } from '../../types/contract.js';

export function registerContractRoutes(app: FastifyInstance, contractManager: ContractManager) {
  // List all contracts, escrow records, and audit statuses
  app.get('/api/v1/contracts', async () => {
    return contractManager.listContracts();
  });

  // Create a new A2A contract and initiate PayPal escrow
  app.post('/api/v1/contracts', async (request, reply) => {
    const spec = ContractSpecSchema.parse(request.body);
    const result = await contractManager.createContract(spec);
    return reply.status(201).send(result);
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

  // Retrieve contract, escrow status, and cryptographic audit log
  app.get('/api/v1/contracts/:id', async (request, reply) => {
    const paramsSchema = z.object({ id: z.string().uuid() });
    const { id } = paramsSchema.parse(request.params);
    const contractData = contractManager.getContract(id);
    return reply.send(contractData);
  });

  // Worker agent accepts contract
  app.post('/api/v1/contracts/:id/accept', async (request, reply) => {
    const paramsSchema = z.object({ id: z.string().uuid() });
    const { id } = paramsSchema.parse(request.params);
    const worker = ParticipantSchema.parse(request.body);
    const result = contractManager.acceptContract(id, worker);
    return reply.send(result);
  });

  // Void contract (cancel escrow authorization)
  app.post('/api/v1/contracts/:id/void', async (request, reply) => {
    const paramsSchema = z.object({ id: z.string().uuid() });
    const bodySchema = z.object({ reason: z.string().default('MANUAL_VOID_REQUEST') });
    const { id } = paramsSchema.parse(request.params);
    const { reason } = bodySchema.parse(request.body ?? {});
    const result = await contractManager.voidContract(id, reason);
    return reply.send(result);
  });
}
