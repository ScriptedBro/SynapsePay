import { ContractManager } from '../core/contract-manager.js';
import { SynapseArbitrator } from '../arbitration/arbitrator.js';

export function getSynapseToolDefinitions() {
  return [
    {
      name: 'synapse_browse_bounties',
      description: 'Browse available AI agent tasks with guaranteed funds locked in PayPal Escrow.',
      parameters: {
        type: 'object',
        properties: {
          filterState: {
            type: 'string',
            enum: ['ESCROW_LOCKED', 'IN_PROGRESS', 'SETTLED', 'ALL'],
            description: 'Filter tasks by escrow state. Defaults to ESCROW_LOCKED.',
          },
        },
      },
    },
    {
      name: 'synapse_deploy_contract',
      description: 'Buyer agent drafts an SLA task specification and initializes a conditional PayPal Escrow hold.',
      parameters: {
        type: 'object',
        required: ['taskTitle', 'taskDescription', 'totalAmountInCents', 'buyerName', 'buyerPayPalEmail'],
        properties: {
          taskTitle: { type: 'string', description: 'Title of the task' },
          taskDescription: { type: 'string', description: 'Detailed functional instructions' },
          totalAmountInCents: { type: 'integer', description: 'Budget in integer cents (e.g. 5000 = $50.00)' },
          buyerName: { type: 'string' },
          buyerPayPalEmail: { type: 'string' },
          deterministicPattern: { type: 'string', description: 'Regex pattern or schema requirement' },
        },
      },
    },
    {
      name: 'synapse_accept_bounty',
      description: 'Worker agent accepts and commits to an active, funded PayPal escrow task.',
      parameters: {
        type: 'object',
        required: ['contractId', 'workerId', 'workerName', 'workerPayPalEmail'],
        properties: {
          contractId: { type: 'string', description: 'UUID of the contract' },
          workerId: { type: 'string', description: 'UUID of the worker agent' },
          workerName: { type: 'string', description: 'Name of the worker agent' },
          workerPayPalEmail: { type: 'string', description: 'Worker PayPal sandbox email for payout' },
        },
      },
    },
    {
      name: 'synapse_submit_deliverable',
      description: 'Worker agent submits code/data artifacts to trigger autonomous arbitration and instant PayPal payout release.',
      parameters: {
        type: 'object',
        required: ['contractId', 'workerId', 'artifactName', 'artifactType', 'artifactContent'],
        properties: {
          contractId: { type: 'string' },
          workerId: { type: 'string' },
          milestoneSequence: { type: 'integer', default: 1 },
          artifactName: { type: 'string' },
          artifactType: { type: 'string', enum: ['CODE', 'DATASET', 'DOCUMENTATION', 'LOGS'] },
          artifactContent: { type: 'string', description: 'Raw code, JSON, or documentation payload' },
        },
      },
    },
    {
      name: 'synapse_get_contract_status',
      description: 'Inspect full contract details, escrow state, timeline, and cryptographic HMAC audit trail.',
      parameters: {
        type: 'object',
        required: ['contractId'],
        properties: {
          contractId: { type: 'string' },
        },
      },
    },
    {
      name: 'synapse_verify_verdict',
      description: 'Offline Ed25519 cryptographic verification of an arbitration verdict signed by Synapse Arbitrator.',
      parameters: {
        type: 'object',
        required: ['verdict'],
        properties: {
          verdict: { type: 'object', description: 'The ArbitrationVerdict object to verify' },
        },
      },
    },
  ];
}

export async function executeSynapseTool(
  name: string,
  args: any,
  contractManager: ContractManager,
  _arbitrator: SynapseArbitrator
): Promise<any> {
  switch (name) {
    case 'synapse_browse_bounties': {
      const all = contractManager.listContracts();
      const filter = args.filterState ?? 'ESCROW_LOCKED';
      if (filter === 'ALL') return all;
      return all.filter((x) => x.escrow.state === filter);
    }

    case 'synapse_deploy_contract': {
      const contractId = crypto.randomUUID();
      const result = await contractManager.createContract({
        id: contractId,
        buyer: {
          id: crypto.randomUUID(),
          role: 'BUYER',
          name: args.buyerName,
          paypalAccount: args.buyerPayPalEmail,
        },
        totalAmountInCents: args.totalAmountInCents,
        currency: 'USD',
        sla: {
          slaId: crypto.randomUUID(),
          taskTitle: args.taskTitle,
          taskDescription: args.taskDescription,
          maxDeliverySeconds: 86400,
          maxArbitrationRetries: 2,
          minOverallScore: 80,
          partialReleaseThreshold: 60,
          deterministicChecks: args.deterministicPattern
            ? [
                {
                  id: 'chk_det',
                  name: 'Output Conformance',
                  type: 'REGEX_MATCH',
                  targetField: 'artifact',
                  expectedValue: args.deterministicPattern,
                  weight: 2,
                  required: true,
                },
              ]
            : [],
          semanticRubrics: [
            {
              id: 'rub_qual',
              name: 'Technical Quality',
              description: 'Evaluate code modularity and documentation.',
              weight: 2,
              minScore: 75,
              instructions: 'Verify clean structure and absence of bugs.',
            },
          ],
        },
        milestones: [
          {
            sequence: 1,
            name: 'Milestone 1: Complete Delivery',
            amountInCents: args.totalAmountInCents,
            currency: 'USD',
            status: 'PENDING',
          },
        ],
        metadata: {},
      });
      return result;
    }

    case 'synapse_accept_bounty': {
      return contractManager.acceptContract(
        args.contractId,
        {
          id: args.workerId,
          role: 'WORKER',
          name: args.workerName,
          paypalAccount: args.workerPayPalEmail,
        },
        args.workerId
      );
    }

    case 'synapse_submit_deliverable': {
      return contractManager.submitDeliverable(
        {
          contractId: args.contractId,
          workerId: args.workerId,
          milestoneSequence: args.milestoneSequence ?? 1,
          submittedAt: new Date().toISOString(),
          artifacts: [
            {
              name: args.artifactName,
              type: args.artifactType ?? 'CODE',
              content: args.artifactContent,
              metadata: {},
            },
          ],
        },
        args.workerId
      );
    }

    case 'synapse_get_contract_status': {
      return contractManager.getContract(args.contractId);
    }

    case 'synapse_verify_verdict': {
      const isValid = SynapseArbitrator.verifyVerdictSignature(args.verdict);
      return {
        verified: isValid,
        arbitratorPublicKey: args.verdict.arbitratorPublicKey,
        algorithm: 'Ed25519',
        explanation: isValid
          ? 'Verdict signature is valid and untampered.'
          : 'Signature verification failed: payload has been modified or forged.',
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
