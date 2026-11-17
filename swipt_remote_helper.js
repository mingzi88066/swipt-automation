const { Client } = require('/root/.nvm/versions/node/v22.13.1/lib/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js');
const { StreamableHTTPClientTransport } = require('/root/.nvm/versions/node/v22.13.1/lib/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/streamableHttp.js');

const rawUrl = process.argv[2] || 'https://cba7d7e178fb98362eb03de4be4c7483@behavior-endangered-earliest-homeless.trycloudflare.com/mcp';
const command = process.argv[3];

if (!command) {
  console.log('Usage: node swipt_remote_helper.js <url> <command> [args...]');
  console.log('Commands:');
  console.log('  info                  - 获取设备信息');
  console.log('  screenshot <path>     - 截图并保存到本地');
  console.log('  tap <x> <y>           - 点击坐标');
  console.log('  tapLabel <label>      - 点击指定文本按钮');
  console.log('  input <text>          - 输入文字');
  console.log('  launch <bundleId>     - 启动应用');
  console.log('  snapshot              - 获取无障碍树');
  console.log('  readLog               - 读取 auto-call-recorder 日志');
  process.exit(0);
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
  const client = new Client({ name: 'swipt-helper', version: '1.0.0' });
  await client.connect(transport);

  let code = '';
  const args = process.argv.slice(4);

  switch (command) {
    case 'info':
      code = 'return await device.info();';
      break;
    case 'screenshot':
      code = `
const ss = await device.screenshot();
const file = dataDirectory.file('remote_screenshot.png');
await file.write(ss);
return { saved: file.uri };
`;
      break;
    case 'tap':
      code = `await input.tap([${args[0]}, ${args[1]}]); return { ok: true };`;
      break;
    case 'tapLabel':
      code = `
const el = await accessibility.find({ label: ${JSON.stringify(args[0])} }, { timeoutMs: 5000 });
await accessibility.tap(el);
return { ok: true, element: el.label };
`;
      break;
    case 'input':
      code = `
const el = await accessibility.find({ focused: true }, { timeoutMs: 3000 });
await accessibility.setText(el, ${JSON.stringify(args[0])});
return { ok: true };
`;
      break;
    case 'launch':
      code = `await device.launchApplication(${JSON.stringify(args[0])}); return { ok: true };`;
      break;
    case 'snapshot':
      code = `
const snapshot = await accessibility.snapshot({ full: true });
const foreground = await device.foregroundApplication.get();
return { app: foreground, elements: snapshot.root };
`;
      break;
    case 'readLog':
      code = `
const file = dataDirectory.directory('auto-call-recorder').file('debug.log');
try { return await file.text(); } catch { return '(no log)'; }
`;
      break;
    default:
      console.log('Unknown command:', command);
      process.exit(1);
  }

  const result = await client.callTool({
    name: 'js',
    arguments: { code, timeoutMs: 30000 },
  });
  for (const item of result.content) {
    if (item.type === 'text') {
      console.log(item.text);
    }
  }
  await client.close();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
