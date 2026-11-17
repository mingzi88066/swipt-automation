const { Client } = require('/root/.nvm/versions/node/v22.13.1/lib/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js');
const { StreamableHTTPClientTransport } = require('/root/.nvm/versions/node/v22.13.1/lib/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/streamableHttp.js');

const rawUrl = process.argv[2] || 'https://cba7d7e178fb98362eb03de4be4c7483@behavior-endangered-earliest-homeless.trycloudflare.com/mcp';

// Parse credentials from URL
const parsed = new URL(rawUrl);
const token = parsed.username;
const url = new URL(parsed.pathname, `${parsed.protocol}//${parsed.host}`).toString();

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    authProvider: {
      tokens: async () => ({ access_token: token }),
    },
  });
  const client = new Client({ name: 'swipt-test', version: '1.0.0' });

  console.log('Connecting to:', url);
  await client.connect(transport);
  console.log('Connected!');

  const tools = await client.listTools();
  console.log('Tools:', JSON.stringify(tools, null, 2));

  // Try a simple JS command
  const result = await client.callTool({
    name: 'js',
    arguments: {
      code: 'return await device.info();',
      timeoutMs: 10000,
    },
  });
  console.log('device.info result:', JSON.stringify(result, null, 2));

  await client.close();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
