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

// ===== 性能参数（1.0.1 重点：不再每秒抓全屏无障碍树）=====
const IDLE_POLL_MS = 5000; // 空闲时轮询间隔（原 1000ms）
const CALL_POLL_MS = 800; // 确认在通话中时的轮询间隔
const WAKE_WINDOW_MS = 15000; // 收到电话相关事件后 15s 内保持快节奏
const SNAPSHOT_CACHE_MS = 400; // 同一时刻的重复取树直接复用
const LOG_MAX_CHARS = 32 * 1024; // 日志上限（原 96KB，读写开销太大）
const LOG_FLUSH_MS = 2000; // 日志先攒内存，2s 或满 20 行再落盘

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

// ===== 可被事件提前唤醒的等待 =====
// 事件到来时不必等满 IDLE_POLL_MS，立刻开始下一轮检测
let kick: (() => void) | null = null;

function kickLoop() {
  const fn = kick;
  kick = null;
  if (fn) fn();
}

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (kick === finish) kick = null;
      resolve();
    };
    const timer = setTimeout(finish, ms);
    kick = finish;
  });
}

// ===== 日志：内存缓冲 + 定时落盘（避免每行都读改写整个文件）=====
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

// ===== 前台应用：便宜的先探针，避免每次都抓整棵树 =====
function foregroundBundle(fg: unknown): string | null {
  if (typeof fg === "string") return fg;
  if (fg !== null && typeof fg === "object") {
    const obj = fg as Record<string, unknown>;
    for (const key of ["bundleId", "bundleIdentifier", "identifier", "id"]) {
      const value = obj[key];
      if (typeof value === "string") return value;
    }
  }
  return null;
}

async function isPhoneLikelyForeground(): Promise<boolean> {
  // 已在通话中就不再拦截，保证检测连续性
  if (session.inCall) return true;
  let bundle: string | null = null;
  try {
    bundle = foregroundBundle(await device.foregroundApplication.get());
  } catch {
    return true; // 读不到就保守处理，宁可多抓一次也不漏接电话
  }
  if (bundle === null) return true;
  return phoneBundleIds.has(bundle);
}

// ===== 快照：短期缓存 + 并发去重 =====
let snapshotCache: { at: number; root: AccessibilityElement | null } | null =
  null;
let inflightSnapshot: Promise<AccessibilityElement | null> | null = null;

async function getCallRoot(): Promise<AccessibilityElement | null> {
  const now = Date.now();
  if (snapshotCache !== null && now - snapshotCache.at < SNAPSHOT_CACHE_MS) {
    return snapshotCache.root;
  }
  if (inflightSnapshot !== null) return inflightSnapshot;

  inflightSnapshot = (async () => {
    try {
      const snapshot = await accessibility.snapshot({
        scope: "fullScreen",
        full: true,
      });
      snapshotCache = { at: Date.now(), root: snapshot.root };
      return snapshot.root;
    } catch {
      return null;
    }
  })();

  try {
    return await inflightSnapshot;
  } finally {
    inflightSnapshot = null;
  }
}

function hasAnyLabel(el: AccessibilityElement, labels: string[]): boolean {
  if (el.label !== undefined && labels.includes(el.label)) return true;
  return el.children.some((child) => hasAnyLabel(child, labels));
}

async function isCallActive(): Promise<boolean> {
  // 先看前台应用（便宜），不是电话/SpringBoard 就不抓树
  if (!(await isPhoneLikelyForeground())) return false;

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

// ===== 状态机：检测 + 触发（幂等）=====
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

// ===== 监听器一：应用前后台事件（只作为唤醒信号）=====
let lastWakeAt = 0;

async function watchByApplicationEvents(signal: AbortSignal) {
  await writeLog("应用事件监听已启动");
  for await (const event of device.applicationEvents({ signal })) {
    if (signal.aborted) return;
    if (!phoneBundleIds.has(event.bundleId)) continue;
    lastWakeAt = Date.now();
    kickLoop(); // 立即触发下一轮检测，而不是自己再抓一次树
  }
}

// ===== 监听器二：自适应轮询（唯一执行检测的通道）=====
async function watchByPolling(signal: AbortSignal) {
  await writeLog("轮询检测已启动");
  while (!signal.aborted) {
    try {
      await maybeHandle(signal);
    } catch (error) {
      await writeLog(`轮询出错: ${error}`);
    }
    const fast = session.inCall || Date.now() - lastWakeAt < WAKE_WINDOW_MS;
    await waitFor(fast ? CALL_POLL_MS : IDLE_POLL_MS);
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
