import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ContractManager } from '../../core/contract-manager.js';
import { SubmissionPayloadSchema } from '../../types/contract.js';

export function registerSubmissionRoutes(app: FastifyInstance, contractManager: ContractManager) {
  app.post('/api/v1/contracts/:id/submit', async (request, reply) => {
    const paramsSchema = z.object({ id: z.string().uuid() });
    const { id } = paramsSchema.parse(request.params);
    const callerId = request.callerIdentity?.id || (request.headers['x-agent-id'] as string | undefined);

    const submission = SubmissionPayloadSchema.parse({
      ...(request.body as object),
      contractId: id,
    });

    // P1 Fix 8: Block unauthorized impostor submissions with 403
    if (!request.callerIdentity?.isAdmin && callerId && callerId !== submission.workerId) {
      return reply.status(403).send({
        type: 'https://synapsepay.protocol/errors/forbidden',
        title: 'Forbidden',
        status: 403,
        detail: `Worker ${submission.workerId} does not match authenticated caller ${callerId}`,
      });
    }

    try {
      const result = await contractManager.submitDeliverable(submission, callerId);
      return reply.status(200).send(result);
    } catch (err: any) {
      if (err.message?.includes('Impostor') || err.message?.includes('Unauthorized')) {
        return reply.status(403).send({
          type: 'https://synapsepay.protocol/errors/forbidden',
          title: 'Forbidden',
          status: 403,
          detail: err.message,
        });
      }
      throw err;
    }
  });
}
