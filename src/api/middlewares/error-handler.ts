import { FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { InvalidStateTransitionError } from '../../core/state-machine.js';

export function errorHandler(error: FastifyError, _request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ZodError) {
    reply.status(400).send({
      type: 'https://synapsepay.protocol/errors/validation-failed',
      title: 'Validation Error',
      status: 400,
      detail: 'The submitted request payload failed schema validation.',
      errors: error.errors,
    });
    return;
  }

  if (error instanceof InvalidStateTransitionError) {
    reply.status(409).send({
      type: 'https://synapsepay.protocol/errors/conflict',
      title: 'Invalid Escrow Transition',
      status: 409,
      detail: error.message,
    });
    return;
  }

  const statusCode = error.statusCode ?? 500;
  reply.status(statusCode).send({
    type: 'https://synapsepay.protocol/errors/internal-error',
    title: statusCode === 500 ? 'Internal Server Error' : error.name,
    status: statusCode,
    detail: error.message || 'An unexpected error occurred processing the request.',
  });
}
