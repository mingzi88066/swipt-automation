# 自动通话录音 Swiplet

这个 Swiplet 会在你接打电话时，自动点击通话界面上的「更多」→「通话录音」（简体「通话录音」/ 繁体「通話錄音」都识别），触发 iOS 自带的通话录音功能；点完立即挂起，不监测通话是否结束。

## 工作原理

1. **没有任何定时读屏**，一切都由推送事件触发：
   - `device.foregroundApplication`：前台 App 变化（这就是来电/通话界面出现的时刻，通话 UI 属于 `com.apple.InCallService`）
   - `device.applicationEvents`：电话类进程的 launch / foreground
   - `device.displayState`：屏幕亮起（锁屏来电时必发生）
   - `device.locked`：解锁（兜住从锁屏直接接听）
   - 事件到达后先过白名单（只有电话类 App 或 SpringBoard 在前台才继续），再用 `snapshot({ scope: "frontApp", depth: 26 })` 读**一次前台应用**的树；读不到通话特征就立刻回到等待
   - 唯一的时间兜底：90 秒（空闲）/ 60 秒（已点过录音）读一次，仅用于事件丢失的极端情况
2. **只读前台应用，不读整屏**：`scope: "frontApp"` 只遍历当前前台 App，`fullScreen` 还要额外读 SpringBoard 桌面和系统 UI 窗口，节点数翻倍、耗时翻倍
3. 判定：见到「结束 / 挂断」或「停止录音」即认定通话界面；否则要求「静音」+「更多」同时存在（只看「更多」会在别的 App 里误判成通话）
4. 自动点击「更多」，再点「通话录音」；label 含 `通话录音 / 通話錄音 / 录音 / 錄音`（且不含「停止」）即点击，副标题并进 label 也能命中
5. 点完立即挂起：不确认录音状态、不轮询通话是否结束
6. 四个循环（触发流程 / 应用事件 / 前台 App / 屏幕状态）由守护逻辑看护，任一异常退出 5 秒后自动重启
7. 日志内存攒 2 秒或 20 行再落盘，文件上限 32 KB

### 性能说明（1.0.2 → 1.0.9）

`accessibility.snapshot()` 是跨进程操作：读取期间 axauditd 用主队列遍历树，SpringBoard 的渲染要排在它后面。

| 场景 | 1.0.4 | 1.0.6 | 1.0.7 | 1.0.8 | 1.0.9 |
| --- | --- | --- | --- | --- |
| 滚动 / 动画 / 打字 | 约 80 次/分钟（全树） | 0（不跟屏幕推送） | 0 | **0** | **0** |
| 停在主屏 | 0 | 6 秒 1 次全屏 | 6 秒 1 次全屏 | **0**（只在回到桌面那一刻读 1 次） | **0** |
| 在用微信 / 抖音 / Safari | 80 次/分钟 | 0 | 0 | **0** | **0** |
| 通话中（已点过录音） | 0 | 3 秒 1 次全屏 | 5 秒 1 次全屏 | 20 秒兜底 1 次 | **60 秒兜底 1 次，事件最多 3 秒 1 次、只探 1 遍** |
| 单次读取范围 | 整屏 + 全属性 | 整屏 30 层 | 整屏 30 层 | 仅前台 App 26 层 | **仅前台 App 26 层** |
| 熄屏 | 0 | 0 | 0 | **0** | **0** |

演进过程（前四版都栽在同一个前提上：把"读屏"当成主要触发手段）：

- **1.0.2 ~ 1.0.4**：用 `accessibility.find(..., { timeoutMs: Infinity })` 当空闲等待。不带 `poll` 的语义是"读一次树 → 等下一次屏幕变化推送 → 再读一次"，推送只在元素增删时发出。屏幕静止零开销，但只要在滚动、切动画、打字，就退化成每 0.75 秒一次整树拷贝。
- **1.0.5**：改成只等 App 事件。但事件流包含 SpringBoard，回一次桌面就算一次"电话活动"，唤醒后连读 8 遍全树；反过来通话界面出现时常常没有 Phone 的前台事件，于是既卡又漏。
- **1.0.6**：改成固定节奏的浅层探测 + 推送加速。读得少了，但"周期性"本身还在：主屏 6 秒、通话中 3 秒各读一次 `fullScreen`。
- **1.0.7**：加了前台白名单，其余 App 前台不读。但主屏 6 秒、通话中 5 秒的 `fullScreen` 仍在——而 `fullScreen` 要同时读 SpringBoard 和前台 App，单次几百毫秒，就是你回桌面后"一顿一顿"的来源。
- **1.0.8**：删掉所有定时读屏，改为纯事件触发；读取范围从 `fullScreen` 收到 `frontApp`。桌面静止、滚动、在别的 App 里都是 0 次读取，只有"前台 App 变化 / 屏幕亮起 / 解锁 / 电话进程事件"才可能读一次。
- **1.0.9**：现场反馈"点完一次通话录音之后才开始卡"，于是把"点完之后"这一段继续压：录音中事件唤醒只探 1 次（原来连探 3 次）、节流 1.5s→3s、兜底 20s→60s；同时把最近 60 次探测的时间/耗时/触发原因记在内存里，`readLog` 直接带出"最近一分钟读了几次、平均耗时"，用来分辨卡顿到底来自读屏还是系统录音管线本身。

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

想确认"现在到底会不会读屏"，看 `diag` 返回的 `foreground` 和 `stats.skipped`（因前台/熄屏被跳过的次数）即可。

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
const L1_DEPTH = 26;       // 探测深度，越大越准也越慢
const IDLE_WAIT_MS = 90000; // 空闲兜底（无事件的极端情况）
const L1_QUIET_MS = 20000;  // 点过录音后（只为发现界面消失）
```

正常情况下这些兜底根本不会触发——触发靠事件。`L1_DEPTH` 不要低于 20，否则可能只看得到通话窗口、看不到按钮。前台白名单在 `callFrontApps`（默认就是电话类 App + SpringBoard）。
