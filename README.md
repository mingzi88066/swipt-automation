# Swipt 自动化脚本示例

本仓库包含 [Swipt](https://github.com/swipt-automation/swipt) 的自动化脚本示例，可直接通过 Swipt CLI 或 MCP 在你的 iPhone/iPad 上运行。

## 前置条件

1. iOS 设备上已安装并运行 Swipt
2. 已在「开发者 → 本地网络」中启用 Swipt API，记下 URL（如 `http://iPhone.local:29937`）
3. 你的电脑与 iOS 设备在同一局域网
4. 已安装 Node.js 和 Swipt CLI：

```bash
npm install -g @swipt/cli
swipt device add http://iPhone.local:29937
swipt device list
```

## 运行脚本

### 方式一：Swipt CLI（推荐，功能最全）

```bash
# 运行单条表达式
swipt repl run 'await device.info()'

# 运行脚本文件
swipt repl run scripts/01-device-info.js

# 重置 REPL 会话
swipt repl reset
```

### 方式二：Claude Code / Claude Desktop MCP

```bash
claude mcp add --transport http iPhone http://iPhone.local:29937/mcp
```

### 方式三：HTTP + Python（实验性）

```bash
python3 mcp_client_example.py http://iPhone.local:29937/mcp
```

## 脚本说明

| 脚本 | 说明 |
| --- | --- |
| `01-device-info.js` | 获取设备名称、型号、屏幕等信息 |
| `02-screenshot.js` | 截图并保存到数据目录 |
| `03-launch-app.js` | 启动指定 App 并等待它到达前台 |
| `04-find-and-tap.js` | 通过无障碍文本查找元素并点击 |
| `05-input-text.js` | 在搜索框输入文字并提交 |
| `06-swipe-and-scroll.js` | 滑动屏幕、滚动列表、轮询查找元素 |
| `07-http-request.js` | 从 Swipt 内部发起 HTTP 请求 |
| `08-complete-workflow.js` | 完整工作流：解锁 → 打开设置 → 点击 WLAN → 截图 |

## 核心 API 速查

### 设备控制

```js
await device.info();
await device.screenshot();
await device.launchApplication("com.apple.mobilesafari");
await device.unlock();
const locked = await device.locked.get();
```

### 无障碍 / UI 操作

```js
const snapshot = await accessibility.snapshot();
const el = await accessibility.find({ label: "无线局域网" }, { timeoutMs: 5000 });
await accessibility.tap(el);
await accessibility.setText(el, "hello");
await accessibility.perform(el, "scrollDown");
```

### 输入事件

```js
await input.tap([100, 200]);
await input.swipe([200, 600], [200, 200], { durationMs: 300 });
await input.pressKey("return");
await input.pressHome();
```

### 文件与 HTTP

```js
const file = dataDirectory.file("result.json");
await file.write(JSON.stringify({ ok: true }));

const client = new http.Client();
const resp = await client.fetch("https://example.com");
const text = await resp.text();
```

## 开发 Swiplet

```bash
cd swiplet-example
swipt project create .          # 如尚未创建
swipt project build
swipt project deploy            # 构建并安装到设备
swipt swiplet call my-swipt-automation hello
```

## 注意事项

- `127.0.0.1` 或 `iPhone.local` 只在**当前局域网内**可达；云端环境无法直接访问你的设备
- 首次运行需要在 iOS 设备上允许 Swipt 的屏幕录制和无障碍权限
- 部分 API 要求 iOS 26/27 或特定 apiLevel，可在脚本开头检查 `available({ iOS: 26 })`
