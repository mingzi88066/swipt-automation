const { Client } = require('/root/.nvm/versions/node/v22.13.1/lib/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js');
const { StreamableHTTPClientTransport } = require('/root/.nvm/versions/node/v22.13.1/lib/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/streamableHttp.js');
const readline = require('readline');

const rawUrl = process.argv[2] || 'https://cba7d7e178fb98362eb03de4be4c7483@behavior-endangered-earliest-homeless.trycloudflare.com/mcp';

const parsed = new URL(rawUrl);
const token = parsed.username;
const url = new URL(parsed.pathname, `${parsed.protocol}//${parsed.host}`).toString();

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    authProvider: {
      tokens: async () => ({ access_token: token }),
    },
  });
  const client = new Client({ name: 'swipt-shell', version: '1.0.0' });
  await client.connect(transport);
  console.log('Connected to Swipt MCP');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'swipt> ',
  });

  rl.prompt();
  rl.on('line', async (line) => {
    const code = line.trim();
    if (!code) {
      rl.prompt();
      return;
    }
    if (code === 'exit' || code === 'quit') {
      await client.close();
      rl.close();
      return;
    }
    try {
      const result = await client.callTool({
        name: 'js',
        arguments: { code, timeoutMs: 30000 },
      });
      for (const item of result.content) {
        if (item.type === 'text') {
          console.log(item.text);
        } else if (item.type === 'image') {
          console.log('[image data]');
        }
      }
    } catch (err) {
      console.error('Error:', err.message);
    }
    rl.prompt();
  });
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
