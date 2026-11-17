import * as accessibility from "@swipt/api/accessibility";
import type { AccessibilityElement } from "@swipt/api/accessibility";
import * as device from "@swipt/api/device";
import * as fs from "@swipt/api/file-system";
import { defineAction, defineExtension } from "@swipt/api/swiplet";

// ===== 界面文本（按系统语言调整）=====
const MORE_LABEL = "更多";
const RECORD_LABEL = "通话录音";
const STOP_RECORD_LABEL = "停止通话录音";
const CALL_APP_LABELS = ["电话", "電話"];
const CALL_END_LABELS = ["结束", "挂断", "結束", "掛斷"];
const MUTE_LABELS = ["静音", "靜音"];

// 电话相关 bundleId（iOS 的通话界面归属在 SpringBoard 下）
const phoneBundleIds = new Set([
  "com.apple.springboard",
  "com.apple.mobilephone",
  "com.apple.InCallService",
  "com.apple.CoreTelephony",
  "com.apple.CallKitService",
  "com.apple.Phone",
  "com.apple.TelephonyUtilities",
]);

// ===== 行为参数 =====
const STABILIZE_MS = 1200; // 通话界面出现后等待稳定
const MENU_OPEN_MS = 800; // 点击「更多」后等菜单弹出
const FIND_TIMEOUT_MS = 5000; // 找按钮的最长等待
const ATTEMPT_COOLDOWN_MS = 8000; // 一次失败后的冷却
const MAX_ATTEMPTS_PER_CALL = 3; // 每通电话最多尝试次数

// ===== 性能参数（1.0.2：空闲时完全不轮询）=====
const IN_CALL_POLL_MS = 1000; // 仅在通话进行中轮询（用于发现通话结束）
const FALSE_HIT_BACKOFF_MS = 1500; // 误判后重新挂起等待的间隔
const LOG_MAX_CHARS = 32 * 1024;
const LOG_FLUSH_MS = 2000;

// 通话界面的"锚点"元素：只有进入通话才会出现
const CALL_ANCHOR_SELECTORS = CALL_END_LABELS.map((label) => ({ label }));

// ===== 通话会话状态 =====
interface CallSession {
  inCall: boolean;
  recording: boolean;
  attempts: number;
  lastAttemptAt: number;
  busy: boolean;
}
const session: CallSession = {
  inCall: false,
  recording: false,
  attempts: 0,
  lastAttemptAt: 0,
  busy: false,
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ===== 日志：内存缓冲 + 定时落盘 =====
let logBuffer: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

function writeLog(text: string): Promise<void> {
  console.info(`[auto-call-recorder] ${text}`);
  logBuffer.push(`[${new Date().toISOString()}] ${text}`);
  if (logBuffer.length >= 20) {
    void flushLog();
  } else if (flushTimer === null) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushLog();
    }, LOG_FLUSH_MS);
  }
  return Promise.resolve();
}

async function flushLog(): Promise<void> {
  if (flushing || logBuffer.length === 0) return;
  flushing = true;
  const chunk = `${logBuffer.join("\n")}\n`;
  logBuffer = [];
  try {
    const file = fs.dataDirectory.file("debug.log");
    let existing = "";
    try {
      existing = await file.text();
    } catch {}
    const merged = existing + chunk;
    await file.write(
      merged.length > LOG_MAX_CHARS ? merged.slice(-LOG_MAX_CHARS) : merged,
    );
  } catch (e) {
    console.error("[auto-call-recorder] 写日志失败:", e);
  } finally {
    flushing = false;
  }
}

function collectElements(
  el: AccessibilityElement,
  depth: number,
  out: string[],
) {
  const indent = "  ".repeat(depth);
  const parts: string[] = [];
  if (el.role) parts.push(`role=${el.role}`);
  if (el.label) parts.push(`label="${el.label}"`);
  if (el.value) parts.push(`value="${el.value}"`);
  if (el.frame) parts.push(`frame=[${el.frame.join(",")}]`);
  if (el.traits?.length) parts.push(`traits=[${el.traits.join(",")}]`);
  if (parts.length) out.push(`${indent}${parts.join(" ")}`);
  for (const child of el.children) {
    collectElements(child, depth + 1, out);
  }
}

async function dumpScreenToLog(prefix: string) {
  try {
    const snapshot = await accessibility.snapshot({
      scope: "fullScreen",
      full: true,
    });
    const foreground = await device.foregroundApplication.get();
    const lines: string[] = [
      `--- ${prefix} ---`,
      `前台应用: ${JSON.stringify(foreground)}`,
      "无障碍树:",
    ];
    collectElements(snapshot.root, 0, lines);
    await writeLog(lines.join("\n"));
  } catch (e) {
    await writeLog(`${prefix} 截取无障碍树失败: ${e}`);
  }
}

// ===== 判定：当前是否通话界面 =====
function hasAnyLabel(el: AccessibilityElement, labels: string[]): boolean {
  if (el.label !== undefined && labels.includes(el.label)) return true;
  return el.children.some((child) => hasAnyLabel(child, labels));
}

// 只在确认要判定时调用（进入通话锚点后），不在空闲时调用
async function isCallScreen(): Promise<boolean> {
  try {
    const snapshot = await accessibility.snapshot({
      scope: "fullScreen",
      full: true,
    });
    const root = snapshot.root;
    if (root.label !== undefined && CALL_APP_LABELS.includes(root.label)) {
      return true;
    }
    const hasEnd = hasAnyLabel(root, CALL_END_LABELS);
    if (!hasEnd) {
      return hasAnyLabel(root, [STOP_RECORD_LABEL]);
    }
    const hasMute = hasAnyLabel(root, MUTE_LABELS);
    const hasMore = hasAnyLabel(root, [MORE_LABEL]);
    if (hasMute || hasMore) return true;
    return hasAnyLabel(root, [STOP_RECORD_LABEL]);
  } catch {
    return false;
  }
}

async function isAlreadyRecording(): Promise<boolean> {
  try {
    const snapshot = await accessibility.snapshot({
      scope: "fullScreen",
      full: true,
    });
    return hasAnyLabel(snapshot.root, [STOP_RECORD_LABEL]);
  } catch {
    return false;
  }
}

async function findAndTap(
  label: string,
  signal: AbortSignal,
  timeoutMs = FIND_TIMEOUT_MS,
): Promise<boolean> {
  const element = await accessibility.find(
    { label },
    { timeoutMs, poll: true, signal },
  );
  if (element === null) {
    await writeLog(`未找到「${label}」按钮`);
    return false;
  }
  try {
    await accessibility.tap(element, { timeoutMs: 3000, signal });
  } catch (error) {
    if (signal.aborted || (error as Error).name === "AbortError") throw error;
    await writeLog(`点击「${label}」失败: ${error}`);
    return false;
  }
  await writeLog(`已点击「${label}」`);
  return true;
}

// ===== 触发录音，成功返回 true =====
async function recordCall(signal: AbortSignal): Promise<boolean> {
  if (await isAlreadyRecording()) {
    await writeLog("已在录音中，无需重复点击");
    return true;
  }

  await writeLog("检测到通话界面，准备开启录音");
  await sleep(STABILIZE_MS);
  if (signal.aborted) return false;

  for (let round = 0; round < 2; round++) {
    if (!(await findAndTap(MORE_LABEL, signal))) {
      await dumpScreenToLog("未找到更多按钮时的界面");
      return false;
    }

    await sleep(MENU_OPEN_MS);
    if (signal.aborted) return false;

    if (await findAndTap(RECORD_LABEL, signal, 4000)) {
      try {
        const confirmed = await accessibility.find(
          { label: STOP_RECORD_LABEL },
          { timeoutMs: 3000, poll: true, signal },
        );
        if (confirmed !== null) {
          await writeLog("录音已开启 ✅");
          return true;
        }
      } catch (error) {
        if (signal.aborted || (error as Error).name === "AbortError") {
          throw error;
        }
      }
      await writeLog("已点击「通话录音」（未读到确认按钮，请留意设备）");
      return true;
    }

    if (round === 0) {
      await writeLog("菜单未出现，重试点击「更多」");
    }
  }

  await dumpScreenToLog("未找到通话录音按钮时的界面");
  return false;
}

// ===== 空闲等待：不轮询，靠系统"屏幕推送"唤醒 =====
// accessibility.find 不带 poll 时，一次读取后挂起等待下一次屏幕变化推送，
// 静止的桌面上几乎不产生任何读取，这是"只在通话界面时运行"的关键。
let waitController: AbortController | null = null;

function restartIdleWait() {
  const controller = waitController;
  waitController = null;
  controller?.abort();
}

async function waitForCallAnchor(signal: AbortSignal): Promise<void> {
  const controller = new AbortController();
  const forward = () => controller.abort();
  signal.addEventListener("abort", forward, { once: true });
  waitController = controller;
  try {
    await accessibility.find(CALL_ANCHOR_SELECTORS, {
      timeoutMs: Number.POSITIVE_INFINITY,
      signal: controller.signal,
    });
  } catch {
    // 被中断（前台事件唤醒 / 服务停止）属正常路径
  } finally {
    if (waitController === controller) waitController = null;
    signal.removeEventListener("abort", forward);
  }
}

// 通话进行中：只有这时候才轮询，用于发现通话结束
async function watchCallUntilEnd(signal: AbortSignal) {
  while (!signal.aborted) {
    if (!(await isCallScreen())) {
      session.inCall = false;
      session.recording = false;
      session.attempts = 0;
      await writeLog("通话结束");
      return;
    }
    await sleep(IN_CALL_POLL_MS);
  }
}

// 命中锚点后走一次判定 + 触发流程；返回 true 表示确实处理了一通电话
async function handleCallIfAny(signal: AbortSignal): Promise<boolean> {
  if (!(await isCallScreen())) return false;

  session.inCall = true;
  const recentAttempt =
    Date.now() - session.lastAttemptAt < ATTEMPT_COOLDOWN_MS;

  if (
    !session.recording &&
    !session.busy &&
    session.attempts < MAX_ATTEMPTS_PER_CALL &&
    !recentAttempt
  ) {
    session.busy = true;
    session.attempts++;
    session.lastAttemptAt = Date.now();
    try {
      session.recording = await recordCall(signal);
      if (!session.recording) {
        await writeLog(
          `第 ${session.attempts}/${MAX_ATTEMPTS_PER_CALL} 次尝试未成功`,
        );
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        await writeLog(`触发录音失败: ${error}`);
      }
    } finally {
      session.busy = false;
    }
  }

  await watchCallUntilEnd(signal);
  return true;
}

// ===== 唯一的执行循环：挂起等待 → 命中 → 处理 → 再挂起 =====
async function watchCalls(signal: AbortSignal) {
  await writeLog("通话监听已启动（空闲时零轮询）");
  while (!signal.aborted) {
    await waitForCallAnchor(signal);
    if (signal.aborted) return;
    try {
      const handled = await handleCallIfAny(signal);
      if (!handled) await sleep(FALSE_HIT_BACKOFF_MS);
    } catch (error) {
      if (signal.aborted || (error as Error).name === "AbortError") return;
      await writeLog(`处理出错: ${error}`);
      await sleep(FALSE_HIT_BACKOFF_MS);
    }
  }
}

// ===== 事件监听：电话类 App 进前台时打断等待，重新判定一次 =====
// 纯事件驱动，不产生任何定时器；用来兜住"屏幕推送丢失"的情况。
async function watchByApplicationEvents(signal: AbortSignal) {
  await writeLog("应用事件监听已启动");
  for await (const event of device.applicationEvents({ signal })) {
    if (signal.aborted) return;
    if (!phoneBundleIds.has(event.bundleId)) continue;
    restartIdleWait();
  }
}

function simplifyTree(
  element: AccessibilityElement,
  depth = 0,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (element.role) result.role = element.role;
  if (element.label) result.label = element.label;
  if (element.value) result.value = element.value;
  if (element.frame) result.frame = element.frame;
  if (element.traits?.length) result.traits = element.traits;
  if (element.children.length && depth < 3) {
    result.children = element.children.map((child) =>
      simplifyTree(child, depth + 1),
    );
  }
  return result;
}

export default defineExtension({
  async run({ signal }) {
    await writeLog("========== 服务已启动 (1.0.2) ==========");

    const supervise = async (name: string, task: () => Promise<void>) => {
      while (!signal.aborted) {
        try {
          await task();
          if (signal.aborted) return;
          await writeLog(`${name}已退出，5 秒后重启`);
        } catch (error) {
          if (signal.aborted || (error as Error).name === "AbortError") return;
          await writeLog(`${name}出错: ${error}`);
        }
        await sleep(5000);
      }
    };

    await Promise.all([
      supervise("触发流程", () => watchCalls(signal)),
      supervise("应用事件监听", () => watchByApplicationEvents(signal)),
    ]);

    await flushLog();
  },

  actions: {
    inspect: defineAction({
      title: "Inspect Current Screen",
      description: "打印当前无障碍树，用于调试",
      run: async () => {
        const snapshot = await accessibility.snapshot({
          scope: "fullScreen",
          full: true,
        });
        const foreground = await device.foregroundApplication.get();
        await dumpScreenToLog("inspect 动作");
        return {
          app: foreground,
          tree: simplifyTree(snapshot.root),
        };
      },
    }),

    triggerOnce: defineAction({
      title: "Trigger Once",
      description: "立即尝试点击当前通话界面的录音按钮",
      run: async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        try {
          const ok = await recordCall(controller.signal);
          return { ok };
        } finally {
          clearTimeout(timeout);
        }
      },
    }),

    readLog: defineAction({
      title: "Read Debug Log",
      description: "读取自动记录的调试日志",
      run: async () => {
        try {
          await flushLog();
          const file = fs.dataDirectory.file("debug.log");
          return { log: await file.text() };
        } catch {
          return { log: "(日志文件不存在)" };
        }
      },
    }),

    clearLog: defineAction({
      title: "Clear Debug Log",
      description: "清空调试日志文件",
      run: async () => {
        try {
          logBuffer = [];
          await fs.dataDirectory.file("debug.log").write("");
          return { cleared: true };
        } catch {
          return { cleared: false };
        }
      },
    }),
  },
});
