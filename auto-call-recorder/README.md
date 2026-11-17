# 自动通话录音 Swiplet

这个 Swiplet 会在你接打电话时，自动点击通话界面上的「更多」→「通话录音」，触发 iOS 自带的通话录音功能。

## 工作原理

1. 以后台 Service 形式运行，监听 `applicationEvents`
2. 当检测到电话应用（`com.apple.mobilephone`、`com.apple.InCallService` 等）进入前台时触发
3. 自动点击「更多」按钮
4. 在弹出的菜单中点击「通话录音」

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

## 常见问题

### Q: 为什么没有自动触发？

1. 检查服务是否已启用：`swipt swiplet service watch auto-call-recorder`
2. 检查 bundleId 是否正确：先运行 `inspect` 动作
3. 检查按钮文本是否匹配：不同 iOS 版本或语言可能不同
4. 检查 Swipt 的无障碍权限是否已开启

### Q: 会不会在每次切到电话应用都触发？

代码里通过 `pid` 做了去重，同一个通话进程只会触发一次。

### Q: 接听电话时也能触发吗？

当前逻辑会在电话应用进入前台时触发。如果是接听来电，电话应用同样会进入前台，因此也会触发。

但如果你希望在「接通后」才触发（而不是响铃时就触发），需要额外判断通话状态，目前 API 中没有直接获取通话状态的方法，可以通过检测计时器是否出现（`00:00` 或 `00:01`）作为启发式判断。

## 自定义

在 `src/extension.ts` 顶部可以修改：

```ts
const MORE_LABEL = "更多";        // 改为你的系统显示文本
const RECORD_LABEL = "通话录音";   // 改为你的系统显示文本
```

如果点击后菜单弹出较慢，可以调大 `await sleep(600)` 的等待时间。
