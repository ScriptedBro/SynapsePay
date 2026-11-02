import { describe, it, expect, vi } from 'vitest';
import { getSynapseToolDefinitions, executeSynapseTool } from '../../src/mcp/tools.js';
import { ContractManager } from '../../src/core/contract-manager.js';
import { SynapseArbitrator } from '../../src/arbitration/arbitrator.js';
import { PayPalOrdersManager } from '../../src/paypal/orders.js';
import { PayPalPayoutsManager } from '../../src/paypal/payouts.js';
import { PayPalClient } from '../../src/paypal/client.js';

describe('MCP Agent Tools Integration (P1 Fix 14 & 15)', () => {
  const secret = 'super_secure_audit_secret_key_32_characters';

  function createTestSetup() {
    const mockClient = new PayPalClient({
      clientId: 'mock_client',
      clientSecret: 'mock_secret',
      mode: 'sandbox',
    });

    const ordersManager = new PayPalOrdersManager(mockClient);
    const payoutsManager = new PayPalPayoutsManager(mockClient);

    vi.spyOn(ordersManager, 'createAuthorizationOrder').mockResolvedValue({
      orderId: 'ORD_MCP_MOCK_123',
      status: 'CREATED',
      approvalUrl: 'https://sandbox.paypal.com/checkoutnow?token=ORD_MCP_MOCK_123',
    });

    vi.spyOn(ordersManager, 'captureAuthorization').mockResolvedValue({
      captureId: 'CAP_MCP_456',
      status: 'COMPLETED',
      amount: { value: '50.00', currency_code: 'USD' },
    });

    vi.spyOn(payoutsManager, 'executeMilestonePayout').mockResolvedValue({
      payoutBatchId: 'BATCH_MCP_789',
      batchStatus: 'SUCCESS',
      senderBatchId: 'sender_mcp_123',
    });

    const arbitrator = new SynapseArbitrator(secret);

    const contractManager = new ContractManager({
      ordersManager,
      payoutsManager,
      arbitrator,
      hmacSecret: secret,
    });

    contractManager.seedSampleContracts();

    return { contractManager, arbitrator };
  }

  it('exposes well-formed MCP tool definitions with schemas', () => {
    const tools = getSynapseToolDefinitions();
    expect(tools.length).toBeGreaterThanOrEqual(8);

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('synapse_browse_bounties');
    expect(toolNames).toContain('synapse_deploy_contract');
    expect(toolNames).toContain('synapse_lock_escrow');
    expect(toolNames).toContain('synapse_propose_terms');
    expect(toolNames).toContain('synapse_accept_terms');
    expect(toolNames).toContain('synapse_accept_bounty');
    expect(toolNames).toContain('synapse_submit_deliverable');
    expect(toolNames).toContain('synapse_get_contract_status');
    expect(toolNames).toContain('synapse_get_agent_reputation');
    expect(toolNames).toContain('synapse_verify_verdict');

    for (const tool of tools) {
      expect(tool.description).toBeDefined();
      expect(tool.parameters).toHaveProperty('type', 'object');
    }
  });

  it('executes synapse_browse_bounties across seeded contracts', async () => {
    const { contractManager, arbitrator } = createTestSetup();
    const bounties = await executeSynapseTool('synapse_browse_bounties', { filterState: 'ALL' }, contractManager, arbitrator);
    expect(Array.isArray(bounties)).toBe(true);
    expect(bounties.length).toBeGreaterThanOrEqual(3);
  });

  it('completes the full end-to-end MCP agent lifecycle (deploy -> lock -> accept -> submit -> verify)', async () => {
    const { contractManager, arbitrator } = createTestSetup();

    // 1. Deploy contract via MCP
    const deployed = await executeSynapseTool(
      'synapse_deploy_contract',
      {
        taskTitle: 'MCP Tool Automation Task',
        taskDescription: 'Generate automated unit test reports',
        totalAmountInCents: 5000,
        buyerName: 'Agent Procurement DAO',
        buyerPayPalEmail: 'procure@dao.org',
      },
      contractManager,
      arbitrator
    );

    expect(deployed.contract.id).toBeDefined();
    expect(deployed.escrow.state).toBe('ESCROW_PENDING');

    // 2. Lock escrow hold via MCP tool (P1 Fix 15)
    const lockedEscrow = await executeSynapseTool(
      'synapse_lock_escrow',
      {
        contractId: deployed.contract.id,
        authorizationId: 'AUTH_MCP_7788',
      },
      contractManager,
      arbitrator
    );
    expect(lockedEscrow.state).toBe('ESCROW_LOCKED');
    expect(lockedEscrow.paypalAuthorizationId).toBe('AUTH_MCP_7788');

    // 3. Worker accepts bounty via MCP
    const workerId = 'c1eebc99-9c0b-4ef8-bb6d-6bb9bd380c33';
    const accepted = await executeSynapseTool(
      'synapse_accept_bounty',
      {
        contractId: deployed.contract.id,
        workerId,
        workerName: 'Autonomous Builder Bot',
        workerPayPalEmail: 'builder@bot.io',
      },
      contractManager,
      arbitrator
    );
    expect(accepted.contract.worker?.name).toBe('Autonomous Builder Bot');
    expect(accepted.escrow.state).toBe('IN_PROGRESS');

    // 4. Submit deliverable via MCP
    const deliverablePayload = JSON.stringify({
      status: 'complete',
      coverage: 95,
      structure: 'clean modular architecture with interfaces',
      documentation: 'comprehensive types and documentation',
      bugs: 'zero syntax or logic defects',
    });

    const submissionResult = await executeSynapseTool(
      'synapse_submit_deliverable',
      {
        contractId: deployed.contract.id,
        workerId,
        milestoneSequence: 1,
        artifactName: 'report.json',
        artifactType: 'DATASET',
        artifactContent: deliverablePayload,
      },
      contractManager,
      arbitrator
    );

    expect(submissionResult.verdict.signedVerdictSignature).toBeDefined();
    // P0 Fix 5: State is PAYOUT_PENDING until PayPal webhook arrives
    expect(submissionResult.escrow.state).toBe('PAYOUT_PENDING');

    // 5. Verify verdict cryptographically via MCP tool (P0 Fix 1)
    const verification = await executeSynapseTool(
      'synapse_verify_verdict',
      {
        verdict: submissionResult.verdict,
        trustedPublicKeyHex: arbitrator.getPublicKey(),
      },
      contractManager,
      arbitrator
    );

    expect(verification.verified).toBe(true);
    expect(verification.algorithm).toBe('Ed25519');

    // 6. Query agent reputation via MCP (P2 Differentiator)
    const reputation = await executeSynapseTool(
      'synapse_get_agent_reputation',
      { agentId: workerId },
      contractManager,
      arbitrator
    );
    expect(reputation.agentId).toBe(workerId);
    expect(reputation.arbitratorPublicKey).toBe(arbitrator.getPublicKey());
    expect(reputation.attestationSignature).toBeDefined();
  });
});
