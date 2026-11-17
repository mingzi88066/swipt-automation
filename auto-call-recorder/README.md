# 自动通话录音 Swiplet

这个 Swiplet 会在你接打电话时，自动点击通话界面上的「更多」→「通话录音」，触发 iOS 自带的通话录音功能。

## 工作原理

1. 以后台 Service 形式运行，**事件监听 + 轮询兜底**双通道检测：
   - 监听 `applicationEvents`（电话/通话相关 bundleId 进前台时唤醒）
   - 同时每秒轮询一次无障碍快照（`scope: "fullScreen"`，能读到挂在 SpringBoard 上的通话界面）
2. 检测逻辑：界面同时出现「结束/挂断」+「静音/更多」才认定为通话界面，避免普通弹窗误判
3. 自动点击「更多」按钮，再点击「通话录音」
4. 每通电话最多尝试 3 次（间隔 8 秒），已开启录音不会重复点击
5. 两个监听器由守护逻辑看护，任一异常退出会在 5 秒后自动重启，服务不会悄悄停止

### App 内开关

Swiplet 自带界面里有「启用自动录音」开关和服务状态显示（启动中/运行中/已停止/出错）。

## 文件结构

```
auto-call-recorder/
├── package.json       # Swiplet 配置与依赖
├── tsconfig.json      # TypeScript 配置
├── README.md          # 本文件
└── src/
    ├── App.tsx        # Swiplet 应用界面
    └── extension.ts   # 自动化逻辑
```

## 安装步骤

### 方式 A：在 Swipt App 里添加仓库源（最简单，推荐）

Swipt App → Swiplets（Swiplet 页）→ 添加 → 输入仓库 URL：

```
https://mingzi88066.github.io/swiplets/swiplets.json
```

然后在列表里点「自动通话录音」安装，装完在界面里打开服务开关即可。以后有新版本，App 会自动提示更新（更新由 mingzi88066.github.io 仓库的 `swiplets/` 目录提供，更新方法见下）。

#### 如何发布新版本

```bash
cd auto-call-recorder
# 改 package.json 里的 version（如 1.0.1）
npm install && npx swipt project build
npx swipt project source dist/auto-call-recorder.swiplet
# 把 dist/swiplets.json 和 dist/auto-call-recorder.swiplet 复制到
# mingzi88066.github.io 仓库的 swiplets/ 目录并 push
```

### 方式 B：在手机 Linux 虚拟机里一键安装（无需电脑）

适用于 iPhone 上运行 LinuxRunner / Debian 虚拟机的情况。在虚拟机终端里执行：

```bash
curl -fsSL -o install-on-phone.sh https://raw.githubusercontent.com/mingzi88066/swipt-automation/main/install-on-phone.sh
sh install-on-phone.sh
```

脚本会自动：安装 Node 22（CLI 在 Node 20 上会崩溃）→ 安装 Swipt CLI → 连接本机 Swipt（`http://10.7.0.1:29937`，走 Loopback VPN）→ 下载并安装 `releases/auto-call-recorder.swiplet` → 启用服务。

注意事项：

- 前提：手机上 Loopback VPN（LocalDevVPN）已开启、Swipt App 已完成初始设置
- 虚拟机里 Node 20 会报 `Iterator is not defined`——这是 CLI 要求 Node 22+，脚本已处理
- 如果 `10.7.0.1` 连不上，改用手机局域网 IP：`DEVICE_URL=http://192.168.x.x:29937 sh install-on-phone.sh`
- 命令是 `swipt`，不是 `swift`（容易打错）

### 方式 B：用 Mac / 电脑安装

### 1. 安装依赖

```bash
cd auto-call-recorder
npm install
```

### 2. 构建并部署到设备

```bash
# 确保设备已添加
swipt device add http://iPhone.local:29937

# 构建并安装
swipt project deploy

# 启用服务
swipt swiplet service enable auto-call-recorder
```

### 3. 调试

实时日志（推荐，`console.info` 会输出到设备日志）：

```bash
swipt device logs --follow --swiplet auto-call-recorder
```

首次使用前，建议先确认界面元素文本和 bundleId 是否正确：

```bash
# 进入通话界面后，在电脑上运行：
swipt swiplet call auto-call-recorder inspect
```

这会输出当前前台应用和无障碍树，检查以下信息：
- 当前应用 bundleId
- 「更多」按钮的 `label` 是否为 `"更多"`
- 「通话录音」按钮的 `label` 是否为 `"通话录音"`

如果文本不同，修改 `src/extension.ts` 顶部的 `MORE_LABEL` 和 `RECORD_LABEL`。

也可以直接手动触发一次：

```bash
swipt swiplet call auto-call-recorder triggerOnce
```

调试日志同时会写入设备上的 `debug.log`（自动截断到 96 KB），读取：

```bash
swipt swiplet call auto-call-recorder readLog
```

## 常见问题

### Q: 为什么没有自动触发？

1. 检查服务是否已启用：`swipt swiplet service watch auto-call-recorder`
2. 检查按钮文本是否匹配：先运行 `inspect` 动作，看通话界面的实际 label
3. 检查 Swipt 的无障碍权限是否已开启（设置 → 辅助功能）
4. 看实时日志：`swipt device logs --follow --swiplet auto-call-recorder`
5. 无障碍 API 需要 **iOS 26+**，更低版本无法使用本 Swiplet

### Q: 会不会在每次切到电话应用都触发？

不会。只有界面同时出现「结束/挂断」+「静音/更多」等通话特征按钮时才会触发，且回到主屏等 SpringBoard 前台事件会先经过通话界面验证，不会盲目点击。

### Q: 接听电话时也能触发吗？

来电接听、去电都会触发。检测到界面后会先等 1.2 秒让界面稳定，再执行点击。

### Q: 服务跑一会儿就不工作了？

旧版本里两个监听器用 `Promise.race` 并联，任一出错整个服务会静默停止。现已改为守护模式：监听器异常退出后 5 秒自动重启。如果你还在用旧版，重新 `swipt project deploy` 一次。

## 自定义

在 `src/extension.ts` 顶部可以修改：

```ts
const MORE_LABEL = "更多";        // 改为你的系统显示文本
const RECORD_LABEL = "通话录音";   // 改为你的系统显示文本
```

如果点击后菜单弹出较慢，可以调大 `await sleep(600)` 的等待时间。
