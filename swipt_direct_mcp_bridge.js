// 这个脚本作为本地 MCP server，通过 stdio 与 Claude 通信，
// 然后通过 Streamable HTTP 转发到 Swipt MCP server。
// 用法：node swipt_direct_mcp_bridge.js <swipt-mcp-url>

const { Client } = require('/root/.nvm/versions/node/v22.13.1/lib/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js');
const { StreamableHTTPClientTransport } = require('/root/.nvm/versions/node/v22.13.1/lib/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/streamableHttp.js');
const { Server } = require('/root/.nvm/versions/node/v22.13.1/lib/node_modules/@modelcontextprotocol/sdk/dist/cjs/server/index.js');
const { StdioServerTransport } = require('/root/.nvm/versions/node/v22.13.1/lib/node_modules/@modelcontextprotocol/sdk/dist/cjs/server/stdio.js');

const rawUrl = process.argv[2];
if (!rawUrl) {
  console.error('Usage: node swipt_direct_mcp_bridge.js <swipt-mcp-url>');
  process.exit(1);
}

const parsed = new URL(rawUrl);
const token = parsed.username;
const url = new URL(parsed.pathname, `${parsed.protocol}//${parsed.host}`).toString();

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    authProvider: {
      tokens: async () => ({ access_token: token }),
    },
  });
  const swiptClient = new Client({ name: 'swipt-bridge', version: '1.0.0' });
  await swiptClient.connect(transport);

  const server = new Server({ name: 'swipt-direct-bridge', version: '1.0.0' }, {
    capabilities: { tools: {} },
  });

  const toolsInfo = await swiptClient.listTools();

  server.setRequestHandler('tools/list', async () => toolsInfo);
  server.setRequestHandler('tools/call', async (request) => {
    const result = await swiptClient.callTool({
      name: request.params.name,
      arguments: request.params.arguments,
    });
    return result;
  });

  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);
  console.error('Swipt MCP bridge running on stdio');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
