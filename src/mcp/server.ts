import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { config } from '../config.js';
import { PayPalClient } from '../paypal/client.js';
import { PayPalOrdersManager } from '../paypal/orders.js';
import { PayPalPayoutsManager } from '../paypal/payouts.js';
import { SynapseArbitrator } from '../arbitration/arbitrator.js';
import { ContractManager } from '../core/contract-manager.js';
import { getSynapseToolDefinitions, executeSynapseTool } from './tools.js';

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

  const server = new Server(
    {
      name: 'synapsepay-mcp',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  const toolDefs = getSynapseToolDefinitions();

  // Register tools list
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: toolDefs.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
      })),
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: toolArgs } = request.params;
    try {
      const result = await executeSynapseTool(name, toolArgs, contractManager, arbitrator);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `SynapsePay Error: ${error.message || String(error)}`,
          },
        ],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[SynapsePay MCP Server] Started and connected to stdio transport');
}

main().catch((err) => {
  console.error('[SynapsePay MCP Server] Fatal startup error:', err);
  process.exit(1);
});
