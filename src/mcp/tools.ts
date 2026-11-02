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
      name: 'synapse_lock_escrow',
      description: 'Lock funds in PayPal conditional authorization hold for an initialized contract (required before worker acceptance).',
      parameters: {
        type: 'object',
        required: ['contractId', 'authorizationId'],
        properties: {
          contractId: { type: 'string', description: 'Contract UUID' },
          authorizationId: { type: 'string', description: 'PayPal Authorization ID (e.g. AUTH-12345)' },
        },
      },
    },
    {
      name: 'synapse_propose_terms',
      description: 'Agent proposes counter-offer or negotiated terms on budget or delivery window (P1 Fix 14).',
      parameters: {
        type: 'object',
        required: ['contractId', 'proposerAgentId', 'proposedBy', 'proposedAmountInCents', 'proposedDeliverySeconds'],
        properties: {
          contractId: { type: 'string' },
          proposerAgentId: { type: 'string' },
          proposedBy: { type: 'string', enum: ['BUYER', 'WORKER'] },
          proposedAmountInCents: { type: 'integer' },
          proposedDeliverySeconds: { type: 'integer' },
          notes: { type: 'string' },
        },
      },
    },
    {
      name: 'synapse_accept_terms',
      description: 'Counterparty agent accepts proposed terms, updating contract spec and milestone amounts.',
      parameters: {
        type: 'object',
        required: ['contractId', 'proposalId', 'acceptorAgentId'],
        properties: {
          contractId: { type: 'string' },
          proposalId: { type: 'string' },
          acceptorAgentId: { type: 'string' },
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
      description: 'Worker agent submits code/data artifacts to trigger autonomous arbitration and conditional payout.',
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
      name: 'synapse_get_agent_reputation',
      description: 'Query verifiable performance history, dispute rate, and Ed25519 signed attestation for an AI agent.',
      parameters: {
        type: 'object',
        required: ['agentId'],
        properties: {
          agentId: { type: 'string' },
        },
      },
    },
    {
      name: 'synapse_verify_verdict',
      description: 'Cryptographic verification of an arbitration verdict using trusted arbitrator public key (P0 Fix 1).',
      parameters: {
        type: 'object',
        required: ['verdict'],
        properties: {
          verdict: { type: 'object', description: 'The ArbitrationVerdict object to verify' },
          trustedPublicKeyHex: { type: 'string', description: 'Optional trusted public key. Defaults to protocol arbitrator key.' },
        },
      },
    },
  ];
}

export async function executeSynapseTool(
  name: string,
  args: any,
  contractManager: ContractManager,
  arbitrator: SynapseArbitrator
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

    case 'synapse_lock_escrow': {
      return contractManager.confirmEscrowLock(args.contractId, args.authorizationId);
    }

    case 'synapse_propose_terms': {
      return contractManager.proposeTerms(
        args.contractId,
        {
          contractId: args.contractId,
          proposerId: args.proposerAgentId,
          proposedBy: args.proposedBy,
          proposedAmountInCents: args.proposedAmountInCents,
          proposedDeliverySeconds: args.proposedDeliverySeconds,
          notes: args.notes,
        },
        args.proposerAgentId
      );
    }

    case 'synapse_accept_terms': {
      return contractManager.acceptTerms(args.contractId, args.proposalId, args.acceptorAgentId);
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

    case 'synapse_get_agent_reputation': {
      return contractManager.getAgentReputation(args.agentId);
    }

    case 'synapse_verify_verdict': {
      // P0 Fix 1: Pin trusted arbitrator public key, reject circular unpinned verification!
      const trustedKey = args.trustedPublicKeyHex || arbitrator.getPublicKey();
      const isValid = SynapseArbitrator.verifyVerdictSignature(args.verdict, trustedKey);
      return {
        verified: isValid,
        trustedArbitratorKey: trustedKey,
        algorithm: 'Ed25519',
        explanation: isValid
          ? 'Verdict signature verified against trusted arbitrator public key.'
          : 'Verification failed: signature invalid or key mismatch.',
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
