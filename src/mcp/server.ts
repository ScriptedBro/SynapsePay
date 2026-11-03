import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/mcp';
import { ALL_TOOLS_ENABLED } from '@paypal/agent-toolkit/ai-sdk';

import { config } from '../config.js';
import { PayPalClient } from '../paypal/client.js';
import { PayPalOrdersManager } from '../paypal/orders.js';
import { PayPalPayoutsManager } from '../paypal/payouts.js';
import { SynapseArbitrator } from '../arbitration/arbitrator.js';
import { ContractManager } from '../core/contract-manager.js';
import { registerSynapseTools } from './tools.js';

/**
 * Creates the unified MCP Server uniting official PayPal Agent Toolkit tools (47 tools)
 * with SynapsePay's Autonomous A2A Escrow, Arbitration & Reputation tools (10 tools).
 */
export function createUnifiedMcpServer(
  contractManager: ContractManager,
  arbitrator: SynapseArbitrator,
  accessToken: string = 'synapse_ephemeral_token'
): PayPalAgentToolkit {
  const server = new PayPalAgentToolkit({
    accessToken,
    configuration: {
      actions: ALL_TOOLS_ENABLED,
      context: { sandbox: config.PAYPAL_MODE !== 'live' },
    },
  });

  registerSynapseTools(server, contractManager, arbitrator);
  return server;
}

async function main() {
  const paypalClient = new PayPalClient({
    clientId: config.PAYPAL_CLIENT_ID,
    clientSecret: config.PAYPAL_CLIENT_SECRET,
    mode: config.PAYPAL_MODE,
  });

  const ordersManager = new PayPalOrdersManager(paypalClient);
  const payoutsManager = new PayPalPayoutsManager(paypalClient);
  const arbitrator = new SynapseArbitrator(
    config.AUDIT_HMAC_SECRET,
    config.OPENAI_API_KEY,
    config.ARBITRATION_MODEL
  );

  const contractManager = new ContractManager({
    ordersManager,
    payoutsManager,
    arbitrator,
    hmacSecret: config.AUDIT_HMAC_SECRET,
  });

  // Seed sample contracts for living ecosystem context
  contractManager.seedSampleContracts();

  let accessToken = 'synapse_ephemeral_token';
  try {
    if (config.PAYPAL_CLIENT_ID && config.PAYPAL_CLIENT_SECRET) {
      accessToken = await paypalClient.getAccessToken();
    }
  } catch (e: any) {
    console.error(`[SynapsePay MCP Server] Notice: Initial token fetch skipped (${e.message}), using sandbox mode`);
  }

  const server = createUnifiedMcpServer(contractManager, arbitrator, accessToken);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[SynapsePay MCP Server] Unified PayPal Agent Toolkit & SynapsePay server connected to stdio transport');
}

if (process.argv[1]?.endsWith('mcp/server.js') || process.argv[1]?.endsWith('mcp/server.ts')) {
  main().catch((err) => {
    console.error('[SynapsePay MCP Server] Fatal startup error:', err);
    process.exit(1);
  });
}
