import * as accessibility from "@swipt/api/accessibility";
import type { AccessibilityElement } from "@swipt/api/accessibility";
import * as device from "@swipt/api/device";
import * as fs from "@swipt/api/file-system";
import { defineAction, defineExtension } from "@swipt/api/swiplet";

// ===== 界面文本（简体 / 繁体系统都要认）=====
// 注意：「停止通话录音」里也含「通话录音」，所以两套文案必须分开匹配，
// 否则会把"正在录音"的按钮当成"开启录音"再点一次（等于把录音关掉）。
const MORE_LABELS = ["更多"];
const RECORD_LABELS = ["通话录音", "通話錄音", "录音", "錄音"];
const STOP_RECORD_LABELS = [
  "停止通话录音",
  "停止通話錄音",
  "停止录音",
  "停止錄音",
  "停止",
];
const CALL_APP_LABELS = ["电话", "電話", "Phone"];
const CALL_END_LABELS = ["结束", "挂断", "結束", "掛斷", "结束通话", "結束通話"];
const MUTE_LABELS = ["静音", "靜音"];

const MORE_SELECTORS = MORE_LABELS.map((label) => ({ label }));
const RECORD_SELECTORS = RECORD_LABELS.map((label) => ({ label }));

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

// ===== 性能参数（1.0.3：点完录音立即挂起，不再监测通话结束）=====
const QUIET_WATCHDOG_MS = 120_000; // 挂起时的兜底唤醒（仅 1 次读屏 / 2 分钟）
const FALSE_HIT_BACKOFF_MS = 1500; // 误判后重新挂起等待的间隔
const LOG_MAX_CHARS = 32 * 1024;
const LOG_FLUSH_MS = 2000;

// 通话界面的"锚点"元素：只有进入通话才会出现
const CALL_ANCHOR_SELECTORS = CALL_END_LABELS.map((label) => ({ label }));

// ===== 通话会话状态 =====
// quiet：挂起原因。非 null 表示当前完全不读屏，只等事件 / 看门狗唤醒。
//  - "recording"：本通已点过录音，等下一通电话
//  - "exhausted"：本通重试次数用尽，唤醒后允许再试一次
type QuietReason = "recording" | "exhausted";
interface CallSession {
  recording: boolean; // 本通电话已点过录音
  quiet: QuietReason | null; // 挂起中
  attempts: number;
  lastAttemptAt: number;
  busy: boolean;
}
const session: CallSession = {
  recording: false,
  quiet: null,
  attempts: 0,
  lastAttemptAt: 0,
  busy: false,
};

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function sleep(ms: number, options?: { signal?: AbortSignal }): Promise<void> {
  const signal = options?.signal;
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      if (timer !== null) clearTimeout(timer);
      reject(abortError());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
function hasAnyLabel(el: AccessibilityElement, labels: readonly string[]): boolean {
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
      return hasAnyLabel(root, STOP_RECORD_LABELS);
    }
    const hasMute = hasAnyLabel(root, MUTE_LABELS);
    const hasMore = hasAnyLabel(root, MORE_LABELS);
    if (hasMute || hasMore) return true;
    return hasAnyLabel(root, STOP_RECORD_LABELS);
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
    return hasAnyLabel(snapshot.root, STOP_RECORD_LABELS);
  } catch {
    return false;
  }
}

async function findAndTap(
  selectors: readonly { label: string }[],
  name: string,
  signal: AbortSignal,
  timeoutMs = FIND_TIMEOUT_MS,
): Promise<boolean> {
  const element = await accessibility.find(selectors, {
    timeoutMs,
    poll: true,
    signal,
  });
  if (element === null) {
    await writeLog(
      `未找到「${name}」按钮（已尝试: ${selectors.map((s) => s.label).join(" / ")}）`,
    );
    return false;
  }
  try {
    await accessibility.tap(element, { timeoutMs: 3000, signal });
  } catch (error) {
    if (signal.aborted || (error as Error).name === "AbortError") throw error;
    await writeLog(`点击「${element.label ?? name}」失败: ${error}`);
    return false;
  }
  await writeLog(`已点击「${element.label ?? name}」`);
  return true;
}

// ===== 触发录音，成功返回 true =====
async function recordCall(signal: AbortSignal): Promise<boolean> {
  if (await isAlreadyRecording()) {
    await writeLog("已在录音中，无需重复点击");
    return true;
  }

  await writeLog("检测到通话界面，准备开启录音");
  await sleep(STABILIZE_MS, { signal });
  if (signal.aborted) return false;

  for (let round = 0; round < 2; round++) {
    if (!(await findAndTap(MORE_SELECTORS, "更多", signal))) {
      await dumpScreenToLog("未找到更多按钮时的界面");
      return false;
    }

    await sleep(MENU_OPEN_MS, { signal });
    if (signal.aborted) return false;

    // 点完就结束：不确认录音状态，也不等通话结束
    if (await findAndTap(RECORD_SELECTORS, "通话录音", signal, 4000)) {
      return true;
    }

    if (round === 0) {
      await writeLog("菜单未出现，重试点击「更多」");
    }
  }

  await dumpScreenToLog("未找到通话录音按钮时的界面");
  return false;
}

// ===== 空闲/挂起等待：不轮询，靠系统"屏幕推送"与前台事件唤醒 =====
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

// ===== 点完录音后的"挂起" =====
// 不读屏、不轮询：只等电话类 App 的前台事件（下一通电话一定会触发），
// 外加一个很长的看门狗兜底，防止事件丢失后永久卡住。
let wakeUp: (() => void) | null = null;

function signalPhoneActivity() {
  const resolve = wakeUp;
  wakeUp = null;
  resolve?.();
}

async function waitForWake(signal: AbortSignal): Promise<void> {
  const wake = new Promise<void>((resolve) => {
    wakeUp = resolve;
  });
  const watchdog = sleep(QUIET_WATCHDOG_MS, { signal }).catch(() => undefined);
  try {
    await Promise.race([wake, watchdog]);
  } finally {
    if (wakeUp !== null) wakeUp = null;
  }
}

// 命中锚点后走一次判定 + 触发流程；返回 true 表示确实处理了一通电话
async function handleCallIfAny(signal: AbortSignal): Promise<boolean> {
  if (!(await isCallScreen())) {
    if (session.recording || session.quiet !== null) {
      await writeLog("通话已结束，回到挂起等待");
    }
    session.recording = false;
    session.quiet = null;
    session.attempts = 0;
    return false;
  }

  // 上一通电话点过录音：只有确认"停止录音"已经不在，才算新的一通
  if (session.recording) {
    if (await isAlreadyRecording()) {
      return true;
    }
    await writeLog("检测到新的一通电话，重置录音状态");
    session.recording = false;
    session.quiet = null;
    session.attempts = 0;
  }

  // 本通已经放弃过：每次被唤醒（事件或 2 分钟看门狗）给一次重试机会
  if (session.quiet === "exhausted") {
    session.quiet = null;
    session.attempts = 0;
  }

  if (session.busy) return true;

  if (session.attempts >= MAX_ATTEMPTS_PER_CALL) {
    session.quiet = "exhausted";
    return true;
  }

  const recentAttempt =
    Date.now() - session.lastAttemptAt < ATTEMPT_COOLDOWN_MS;
  if (recentAttempt) {
    const waitMs = ATTEMPT_COOLDOWN_MS - (Date.now() - session.lastAttemptAt);
    await sleep(waitMs, { signal });
    return true;
  }

  session.busy = true;
  session.attempts++;
  session.lastAttemptAt = Date.now();
  try {
    const ok = await recordCall(signal);
    if (ok) {
      session.recording = true;
      session.quiet = "recording";
      await writeLog("录音已触发，直接挂起（不再监测通话是否结束）");
    } else {
      await writeLog(`第 ${session.attempts}/${MAX_ATTEMPTS_PER_CALL} 次尝试未成功`);
      if (session.attempts >= MAX_ATTEMPTS_PER_CALL) {
        session.quiet = "exhausted";
        await writeLog("本通电话暂不重试，挂起等待唤醒");
      }
    }
  } catch (error) {
    if ((error as Error).name !== "AbortError") {
      await writeLog(`触发录音失败: ${error}`);
    }
  } finally {
    session.busy = false;
  }

  return true;
}

// ===== 唯一的执行循环：挂起等待 → 命中 → 处理 → 再挂起 =====
async function watchCalls(signal: AbortSignal) {
  await writeLog("通话监听已启动（1.0.3：点完录音立即挂起）");
  while (!signal.aborted) {
    if (session.quiet !== null) {
      await waitForWake(signal);
      if (signal.aborted) return;
    }
    await waitForCallAnchor(signal);
    if (signal.aborted) return;
    try {
      const handled = await handleCallIfAny(signal);
      if (!handled) await sleep(FALSE_HIT_BACKOFF_MS, { signal });
    } catch (error) {
      if (signal.aborted || (error as Error).name === "AbortError") return;
      await writeLog(`处理出错: ${error}`);
      await sleep(FALSE_HIT_BACKOFF_MS, { signal });
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
    signalPhoneActivity();
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
    await writeLog("========== 服务已启动 (1.0.3) ==========");

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
        await sleep(5000, { signal }).catch(() => undefined);
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
