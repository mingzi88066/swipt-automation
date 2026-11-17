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
const POLL_INTERVAL_MS = 1000; // 轮询间隔
const LOG_MAX_CHARS = 96 * 1024; // 日志文件上限，超过则截断保留后半段

// ===== 通话会话状态（两个监听器共享）=====
interface CallSession {
  inCall: boolean; // 当前是否处于通话界面
  recording: boolean; // 本通电话是否已开启录音
  attempts: number; // 本通电话已尝试次数
  lastAttemptAt: number; // 上次尝试时间
  busy: boolean; // recordCall 是否正在执行
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

// ===== 日志：console（可用 swipt device logs 查看）+ 文件（串行写入，带截断）=====
// 写文件是"读-改-写"，两个监听器并发调用会互相覆盖丢行，所以用队列串行化
let logQueue: Promise<void> = Promise.resolve();

function writeLog(text: string): Promise<void> {
  console.info(`[auto-call-recorder] ${text}`);
  const entry = `[${new Date().toISOString()}] ${text}\n`;
  logQueue = logQueue.then(() => appendLog(entry));
  return logQueue;
}

async function appendLog(entry: string) {
  try {
    const file = fs.dataDirectory.file("debug.log");
    let existing = "";
    try {
      existing = await file.text();
    } catch {}
    if (existing.length > LOG_MAX_CHARS) {
      existing = existing.slice(Math.floor(LOG_MAX_CHARS / 2));
    }
    await file.write(existing + entry);
  } catch (e) {
    console.error("[auto-call-recorder] 写日志失败:", e);
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
    // 通话界面挂在 SpringBoard 覆盖层上，必须用 fullScreen 才能读到
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

// ===== 通话界面检测 =====
async function getCallRoot(): Promise<AccessibilityElement | null> {
  try {
    const snapshot = await accessibility.snapshot({
      scope: "fullScreen",
      full: true,
    });
    return snapshot.root;
  } catch {
    return null;
  }
}

function hasAnyLabel(el: AccessibilityElement, labels: string[]): boolean {
  if (el.label !== undefined && labels.includes(el.label)) return true;
  return el.children.some((child) => hasAnyLabel(child, labels));
}

async function isCallActive(): Promise<boolean> {
  const root = await getCallRoot();
  if (root === null) return false;
  if (root.label !== undefined && CALL_APP_LABELS.includes(root.label)) {
    return true;
  }
  const hasEnd = hasAnyLabel(root, CALL_END_LABELS);
  const hasMute = hasAnyLabel(root, MUTE_LABELS);
  const hasMore = hasAnyLabel(root, [MORE_LABEL]);
  // 「结束」+「静音/更多」组合才认定为通话界面，避免普通弹窗误判
  if ((hasEnd && hasMute) || (hasEnd && hasMore)) return true;
  return hasAnyLabel(root, [STOP_RECORD_LABEL]);
}

async function isAlreadyRecording(): Promise<boolean> {
  const root = await getCallRoot();
  return root !== null && hasAnyLabel(root, [STOP_RECORD_LABEL]);
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

  // 「更多」→「通话录音」，菜单没弹出时重试一次
  for (let round = 0; round < 2; round++) {
    // 第一步：点击「更多」
    if (!(await findAndTap(MORE_LABEL, signal))) {
      await dumpScreenToLog("未找到更多按钮时的界面");
      return false;
    }

    // 等待菜单弹出
    await sleep(MENU_OPEN_MS);
    if (signal.aborted) return false;

    // 第二步：点击「通话录音」
    if (await findAndTap(RECORD_LABEL, signal, 4000)) {
      // 第三步：确认出现「停止通话录音」
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
      // 菜单可能已收起导致确认按钮读不到，视为已点击
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

// ===== 状态机：检测 + 触发（幂等，可被事件/轮询同时调用）=====
async function maybeHandle(signal: AbortSignal) {
  let active: boolean;
  try {
    active = await isCallActive();
  } catch {
    return;
  }

  if (!active) {
    if (session.inCall) {
      session.inCall = false;
      session.recording = false;
      session.attempts = 0;
      await writeLog("通话结束");
    }
    return;
  }

  session.inCall = true;
  if (session.recording || session.busy) return;
  if (session.attempts >= MAX_ATTEMPTS_PER_CALL) return;
  if (Date.now() - session.lastAttemptAt < ATTEMPT_COOLDOWN_MS) return;

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

// ===== 监听器一：应用前后台事件（快速唤醒）=====
async function watchByApplicationEvents(signal: AbortSignal) {
  await writeLog("应用事件监听已启动");
  for await (const event of device.applicationEvents({ signal })) {
    if (signal.aborted) return;
    if (!phoneBundleIds.has(event.bundleId)) continue;
    // 事件只做唤醒，是否真的是通话界面由 maybeHandle 内部验证
    await maybeHandle(signal);
  }
}

// ===== 监听器二：轮询兜底（事件丢失/不支持时也能工作）=====
async function watchByPolling(signal: AbortSignal) {
  await writeLog("轮询检测已启动");
  while (!signal.aborted) {
    try {
      await maybeHandle(signal);
    } catch (error) {
      await writeLog(`轮询出错: ${error}`);
    }
    await sleep(POLL_INTERVAL_MS);
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
    await writeLog("========== 服务已启动 ==========");

    // 守护：任一监听器意外退出都自动重启，服务不再悄悄死掉
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

    // 两个监听器并行（不是 race，谁出问题都不会拖垮另一个）
    await Promise.all([
      supervise("事件监听", () => watchByApplicationEvents(signal)),
      supervise("轮询检测", () => watchByPolling(signal)),
    ]);
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
          await fs.dataDirectory.file("debug.log").write("");
          return { cleared: true };
        } catch {
          return { cleared: false };
        }
      },
    }),
  },
});
