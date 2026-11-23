# 自动通话录音 Swiplet

这个 Swiplet 会在你接打电话时，自动点击通话界面上的「更多」→「通话录音」（简体「通话录音」/ 繁体「通話錄音」都识别），触发 iOS 自带的通话录音功能；点完立即挂起，不监测通话是否结束。

## 工作原理

1. 后台 Service 按「屏幕状态 + 固定节奏」探测，绝大多数时间不读屏：
   - **熄屏即停**：订阅 `device.displayState`，屏幕熄灭（通话中贴耳、锁屏、口袋）时一次读屏都不做
   - **唤醒源全是推送**：前台 App 变化（`device.foregroundApplication`）、电话类 App 事件（`device.applicationEvents`）、屏幕点亮；事件到达立刻探一次（1.5 秒节流）
   - **周期探测用浅层快照**：`snapshot({ scope: "fullScreen", depth: 30 })`，不带 `full`，只读前 30 层，单次跨进程拷贝远小于整棵树
   - 节奏：刚有电话活动 2 秒 / 其他 4 秒 / 已录音后 3 秒（只为发现"界面消失"，接下一通）/ 熄屏不探
   - 点完「通话录音」立刻挂起：不确认录音状态、不轮询通话是否结束
2. 判定：见到「结束 / 挂断」或「停止录音」即认定通话界面；否则要求「静音」+「更多」同时存在（只看「更多」会在别的 App 里误判成通话）
3. 自动点击「更多」，再点「通话录音」；label 含 `通话录音 / 通話錄音 / 录音 / 錄音`（且不含「停止」）即点击，副标题并进 label 也能命中
4. 每通电话最多尝试 3 次（间隔 8 秒）；同一通只处理一次，靠"通话界面消失"判断进入下一通
5. 四个循环（触发流程 / 应用事件 / 前台 App / 屏幕状态）由守护逻辑看护，任一异常退出 5 秒后自动重启
6. 日志内存攒 2 秒或 20 行再落盘，文件上限 32 KB

### 性能说明（1.0.2 → 1.0.6）

`accessibility.snapshot()` 是跨进程操作，每次都要让系统遍历无障碍树，读取期间 SpringBoard 渲染要等它。

| 场景 | 1.0.2 | 1.0.4 | 1.0.5 | 1.0.6 |
| --- | --- | --- | --- | --- |
| 静止桌面 | 0 次 | 0 次 | 0 次 | 0 次 |
| 滚动 / 动画 / 打字 | 约 80 次/分钟（全树） | 约 80 次/分钟（全树） | 回桌面触发连读 8 次全树 | **0 次**（不跟屏幕推送） |
| 亮屏空闲 | 0 次 | 0 次 | 20 秒 1 次全树 | 4 秒 1 次浅层（depth 30） |
| 熄屏 | 0 次 | 0 次 | 仍按 20 秒读 | **0 次** |
| 通话中 | 每秒 1 次 | 0 次 | 60 秒 1 次 | 3 秒 1 次浅层（熄屏 0） |

演进过程：

- **1.0.2 ~ 1.0.4**：空闲等待是 `accessibility.find(..., { timeoutMs: Infinity })`。不带 `poll` 时的语义是"读一次树 → 等下一次屏幕变化推送 → 再读一次"，而推送只在元素增删时发出。屏幕静止确实零开销，但只要你在滚动、切动画、打字，就退化成每 0.75 秒一次整树拷贝 → 掉帧。
- **1.0.5**：改成只等 App 事件。但事件流里包含 SpringBoard，回一次桌面就算一次"电话活动"，而且被唤醒后连读 8 遍全树；反过来，通话界面出现时（Phone 已在后台，CallKit 覆盖层）往往没有 App 前台事件，于是既卡又漏点。
- **1.0.6**：不再依赖"屏幕推送"这种不可控频率的触发，改为固定节奏的浅层探测 + 推送加速；同时熄屏完全静默。负载从"变化多就狂读"变成"每分钟十来次、每次只看 30 层"。

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
- 「通话录音」按钮的 `label` 是否为 `"通话录音"`（繁体系统为 `"通話錄音"`，两套都已内置；带副标题如 `"通話錄音，轉寫和生成摘要"` 也能命中）

只想知道屏幕上所有文案时，可以直接跑 `swipt swiplet call auto-call-recorder labels`，比翻整棵树快。

**通话中**（界面在屏幕上时）跑一次 `diag`，能看到每档读取深度的耗时、节点数、以及是否命中「结束 / 静音 / 更多 / 通话录音 / 停止录音」：

```bash
swipt swiplet call auto-call-recorder diag
```

如果 `depth: 30` 那一行 `end/mute/more` 全是 `false`，说明按钮比 30 层更深，把 `src/extension.ts` 顶部的 `L1_DEPTH` 调大（如 40）；如果耗时都在 100ms 以上，说明设备端读屏本身很慢，优先把 `L1_*_MS` 调大。

如果文本完全不同，修改 `src/extension.ts` 顶部的 `isMoreLabel` / `isRecordLabel` / `isStopRecordLabel` 匹配函数。

也可以直接手动触发一次：

```bash
swipt swiplet call auto-call-recorder triggerOnce
```

调试日志同时会写入设备上的 `debug.log`（自动截断到 32 KB），读取：

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

不会。判定要求界面出现「结束 / 挂断」或「停止录音」，否则必须「静音」+「更多」同时存在；「更多」单独出现（几乎每个 App 都有）不算。

### Q: 接听电话时也能触发吗？

来电接听、去电都会触发。检测到界面后先等 1 秒让动画稳定，再执行点击。点完录音即挂起，不再关心这通电话何时结束。

### Q: 为什么点完录音就不管了？

iOS 的录音会随通话结束自动停止，不需要再确认一次。挂起后只为"发现通话界面消失"每 3 秒做一次浅层探测（熄屏时完全不探），好让下一通电话能重新触发。

### Q: 服务跑一会儿就不工作了？

旧版本里两个监听器用 `Promise.race` 并联，任一出错整个服务会静默停止。现已改为守护模式：监听器异常退出后 5 秒自动重启。如果你还在用旧版，重新 `swipt project deploy` 一次。

## 自定义

在 `src/extension.ts` 顶部可以修改：

```ts
const isMoreLabel = (label) => label.includes("更多");                       // 「更多」按钮
const isRecordLabel = (label) =>
  /(通话录音|通話錄音|录音|錄音)/.test(label) && !label.includes("停止");     // 开启录音
const isStopRecordLabel = (label) =>
  label.trim() === "停止" || (label.includes("停止") && /(录音|錄音)/.test(label)); // 已在录音
```

想加别的语言文案，往正则的可选分支里追加即可。注意：`isRecordLabel` 必须排除「停止」，否则会把"停止录音"当"开启录音"再点一次。

如果点击后菜单弹出较慢，可以调大顶部的 `MENU_OPEN_MS`（如 1200）。

耗电与响应速度的平衡在四个常量上：

```ts
const L1_DEPTH = 30;      // 探测深度，越大越准也越慢
const L1_FAST_MS = 2000;  // 刚有电话活动时的探测间隔
const L1_HOME_MS = 4000;  // 其余情况的探测间隔
const L1_QUIET_MS = 3000; // 点过录音后（只为发现界面消失）
```

想更省电就调大间隔，代价是录音触发变慢；`L1_DEPTH` 不要低于 24，否则可能只看得到通话窗口、看不到按钮。
