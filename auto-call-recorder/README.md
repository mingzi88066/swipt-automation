# 自动通话录音 Swiplet

这个 Swiplet 会在你接打电话时，自动点击通话界面上的「更多」→「通话录音」（简体「通话录音」/ 繁体「通話錄音」都识别），触发 iOS 自带的通话录音功能；点完立即挂起，不监测通话是否结束。

## 工作原理

1. 后台 Service **只在通话界面存在时才运行**：
   - 空闲时用一次 `accessibility.find(..., { timeoutMs: Infinity })`（不带 `poll`）挂起等待系统"屏幕推送"，桌面静止时零读取、零定时器
   - 命中通话锚点（「结束 / 挂断」）后才做一次判定，确认同时有「静音 / 更多」即认定为通话界面
   - 点完「通话录音」后立刻挂起：不确认录音状态、不轮询通话是否结束，只等电话类 App 的前台事件（下一通电话一定会触发）唤醒，另有 2 分钟看门狗兜底
   - `applicationEvents` 仅在电话类 App 进前台时打断等待，兜住推送丢失
2. 检测逻辑：界面同时出现「结束/挂断」+「静音/更多」才认定为通话界面，避免普通弹窗误判
3. 自动点击「更多」按钮，再点击「通话录音」；label 里含 `通话录音 / 通話錄音 / 录音 / 錄音`（且不含「停止」）即点击，副标题并进 label 也能命中
4. 每通电话最多尝试 3 次（间隔 8 秒），已开启录音不会重复点击（「停止通话录音 / 停止通話錄音」视为已在录音）
5. 两个监听器由守护逻辑看护，任一异常退出会在 5 秒后自动重启，服务不会悄悄停止
6. 日志在内存里攒 2 秒或 20 行再落盘，文件上限 32 KB，避免频繁读改写

### 性能说明（1.0.3 / 1.0.4）

`accessibility.snapshot({ scope: "fullScreen", full: true })` 会让系统遍历整棵无障碍树，是跨进程重操作。1.0.0 每秒一次，桌面会出现周期性掉帧、发热掉电；1.0.1 降到 5 秒一次，静止桌面仍然每隔 5 秒卡一下。1.0.2 彻底移除了空闲轮询，但通话中仍每秒读屏判断是否挂断。1.0.3 连通话中的轮询也去掉了：点完录音就直接挂起。

| 优化点 | 1.0.0 | 1.0.1 | 1.0.2 | 1.0.3 |
| --- | --- | --- | --- | --- |
| 空闲时抓树 | 每秒 1 次 | 每 5 秒 1 次 | **0 次**（挂起等推送） | **0 次** |
| 空闲时定时器 | 有 | 有 | 无 | 无 |
| 通话中 | 1s 轮询 | 0.8s | 1s（判断挂断） | **0 次**（点完即挂起） |
| 日志写入 | 每行读改写 ≤96KB | 批量落盘 | 批量落盘 ≤32KB | 批量落盘 ≤32KB |

1.0.4 修的是「点了没反应」：iOS 菜单行会把副标题并进无障碍 label（`通話錄音，轉寫和生成摘要`），精确相等匹配必然漏点，现在改成「label 包含 通话录音 / 通話錄音 且不含 停止」的子串匹配，点完只看一眼菜单是否收起，没收起就重试最多 3 次。

实现要点：`find` **不带 `poll`** 时会在一次读取后挂起，等设备下一次屏幕变化推送（最快 0.75s），因此桌面静止期间不产生任何 AX 读取；只有通话界面出现（新增元素触发推送）才会被唤醒。点完录音后不再读屏，靠 `applicationEvents`（电话类 App 进前台）+ 2 分钟看门狗唤醒，因此通话时长再久也不产生读屏开销。

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

如果文本完全不同，修改 `src/extension.ts` 顶部的 `isMoreLabel` / `isRecordLabel` / `isStopRecordLabel` 匹配函数。

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

来电接听、去电都会触发。检测到界面后会先等 1.2 秒让界面稳定，再执行点击。点完录音即挂起，不再关心这通电话何时结束。

### Q: 为什么点完录音就不管了？

iOS 的录音会随通话结束自动停止，不需要再确认一次；省掉"每秒读屏判断是否挂断"之后，通话时长再久也不会有额外耗电。下一通电话会由电话类 App 的前台事件唤醒，另有 2 分钟看门狗兜底，不会漏触发。

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
挂起期间的兜底唤醒间隔是 `QUIET_WATCHDOG_MS`（默认 2 分钟，仅 1 次读屏），一般不用改。
