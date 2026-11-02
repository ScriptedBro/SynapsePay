import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ContractManager } from '../../core/contract-manager.js';
import { SubmissionPayloadSchema } from '../../types/contract.js';

export function registerSubmissionRoutes(app: FastifyInstance, contractManager: ContractManager) {
  app.post('/api/v1/contracts/:id/submit', async (request, reply) => {
    const paramsSchema = z.object({ id: z.string().uuid() });
    const { id } = paramsSchema.parse(request.params);

    const submission = SubmissionPayloadSchema.parse({
      ...(request.body as object),
      contractId: id,
    });

    const result = await contractManager.submitDeliverable(submission);
    return reply.status(200).send(result);
  });
}
