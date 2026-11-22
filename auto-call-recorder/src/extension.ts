import * as accessibility from "@swipt/api/accessibility";
import type { AccessibilityElement } from "@swipt/api/accessibility";
import * as device from "@swipt/api/device";
import * as fs from "@swipt/api/file-system";
import { defineAction, defineExtension } from "@swipt/api/swiplet";

// ===== 界面文案匹配（简体 / 繁体 / 带副标题都要认）=====
// iOS 的菜单行会把副标题并进无障碍 label，例如「通話錄音，轉寫和生成摘要」，
// 精确相等匹配会漏点，所以这里一律用「包含」判断。
type LabelTest = (label: string) => boolean;

const isMoreLabel: LabelTest = (label) => label.includes("更多");
const isRecordLabel: LabelTest = (label) =>
  /(通话录音|通話錄音|录音|錄音)/.test(label) && !label.includes("停止");
const isStopRecordLabel: LabelTest = (label) =>
  label.trim() === "停止" ||
  (label.includes("停止") && /(录音|錄音)/.test(label));
const isCallEndLabel: LabelTest = (label) => /(结束|挂断|結束|掛斷)/.test(label);
const isMuteLabel: LabelTest = (label) => /(静音|靜音)/.test(label);
const isCallAppLabel: LabelTest = (label) => /^(电话|電話|Phone)$/.test(label);

// 空闲挂起的锚点交给 accessibility.find，只支持精确匹配，所以简繁两种都列上
const CALL_ANCHOR_SELECTORS = [
  { label: "结束" },
  { label: "結束" },
  { label: "挂断" },
  { label: "掛斷" },
  { label: "结束通话" },
  { label: "結束通話" },
];

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
const RECORD_TAP_RETRIES = 3; // 点「通话录音」没生效时的重试次数
const RECORD_CONFIRM_MS = 700; // 点完只看一眼菜单是否收起

// ===== 性能参数（1.0.4：点完录音立即挂起，不再监测通话结束）=====
const QUIET_WATCHDOG_MS = 120_000; // 挂起时的兜底唤醒（仅 1 次读屏 / 2 分钟）
const FALSE_HIT_BACKOFF_MS = 1500; // 误判后重新挂起等待的间隔
const LOG_MAX_CHARS = 32 * 1024;
const LOG_FLUSH_MS = 2000;

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

// ===== 文案查找 / 判定 =====
function hasLabel(el: AccessibilityElement, test: LabelTest): boolean {
  if (el.label !== undefined && test(el.label)) return true;
  return el.children.some((child) => hasLabel(child, test));
}

function collectLabeled(
  el: AccessibilityElement,
  test: LabelTest,
  out: AccessibilityElement[] = [],
): AccessibilityElement[] {
  if (el.label !== undefined && test(el.label)) out.push(el);
  for (const child of el.children) collectLabeled(child, test, out);
  return out;
}

function collectLabels(el: AccessibilityElement, out: string[] = []): string[] {
  if (el.label) out.push(el.label);
  for (const child of el.children) collectLabels(child, out);
  return out;
}

function frameArea(el: AccessibilityElement): number {
  const frame = el.frame;
  return frame ? frame[2] * frame[3] : 0;
}

// 同一行文案常有多层元素带相同 label（按钮 / 文字 / 图标），
// 优先点 traits 带 button 的最小元素，命中率最高。
function pickTappable(
  matches: AccessibilityElement[],
): AccessibilityElement | null {
  const buttons = matches.filter((el) => el.traits?.includes("button"));
  const pool = buttons.length > 0 ? buttons : matches;
  let best: AccessibilityElement | null = null;
  for (const el of pool) {
    if (best === null) {
      best = el;
      continue;
    }
    const area = frameArea(el);
    if (area > 0 && (area < frameArea(best) || frameArea(best) === 0)) best = el;
  }
  return best;
}

async function readScreen() {
  return accessibility.snapshot({ scope: "fullScreen", full: true });
}

// 只在确认要判定时调用（进入通话锚点后），不在空闲时调用
async function isCallScreen(): Promise<boolean> {
  try {
    const root = (await readScreen()).root;
    if (root.label !== undefined && isCallAppLabel(root.label)) return true;
    if (!hasLabel(root, isCallEndLabel)) {
      return hasLabel(root, isStopRecordLabel);
    }
    if (hasLabel(root, isMuteLabel) || hasLabel(root, isMoreLabel)) return true;
    return hasLabel(root, isStopRecordLabel);
  } catch {
    return false;
  }
}

async function isAlreadyRecording(): Promise<boolean> {
  try {
    return hasLabel((await readScreen()).root, isStopRecordLabel);
  } catch {
    return false;
  }
}

// 录音 UI 的三种状态：正在录音 / 「更多」菜单还开着 / 两者都没有
type RecordUiState = "recording" | "menu" | "plain";

async function readRecordUiState(): Promise<RecordUiState> {
  try {
    const root = (await readScreen()).root;
    if (hasLabel(root, isStopRecordLabel)) return "recording";
    if (hasLabel(root, isRecordLabel)) return "menu";
    return "plain";
  } catch {
    return "plain";
  }
}

// 找可点元素：只在点击那一刻轮询快照，几秒内结束
async function waitForLabeled(
  test: LabelTest,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<AccessibilityElement | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const picked = pickTappable(
        collectLabeled((await readScreen()).root, test),
      );
      if (picked !== null) return picked;
    } catch (error) {
      if (signal.aborted || (error as Error).name === "AbortError") throw error;
    }
    if (Date.now() >= deadline) return null;
    await sleep(350, { signal });
  }
}

async function tapByLabel(
  test: LabelTest,
  name: string,
  signal: AbortSignal,
  timeoutMs = FIND_TIMEOUT_MS,
): Promise<boolean> {
  const element = await waitForLabeled(test, signal, timeoutMs);
  if (element === null) {
    await writeLog(`未找到「${name}」按钮`);
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

  if (!(await tapByLabel(isMoreLabel, "更多", signal))) {
    await dumpScreenToLog("未找到更多按钮时的界面");
    return false;
  }

  await sleep(MENU_OPEN_MS, { signal });
  if (signal.aborted) return false;

  // 点「通话录音 / 通話錄音」：只看一眼这次点击有没有落到按钮上（菜单是否收起），
  // 不确认录音是否真的在跑，更不会去等通话结束。
  for (let attempt = 0; attempt < RECORD_TAP_RETRIES; attempt++) {
    if (!(await tapByLabel(isRecordLabel, "通话录音/通話錄音", signal, 4000))) {
      break;
    }
    await sleep(RECORD_CONFIRM_MS, { signal });
    const state = await readRecordUiState();
    if (state !== "menu") {
      await writeLog(
        state === "recording" ? "录音已开启 ✅" : "菜单已收起，视为已触发录音",
      );
      return true;
    }
    await writeLog(`第 ${attempt + 1} 次点击后菜单仍在，重试`);
  }

  await dumpScreenToLog("点击通话录音未生效时的界面");
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
      await writeLog(
        `第 ${session.attempts}/${MAX_ATTEMPTS_PER_CALL} 次尝试未成功`,
      );
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
  await writeLog("通话监听已启动（1.0.4：简繁识别 + 点完即挂起）");
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
    await writeLog("========== 服务已启动 (1.0.4) ==========");

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

    labels: defineAction({
      title: "List Labels",
      description: "列出当前屏幕上所有文案，便于核对按钮文本",
      run: async () => {
        try {
          return { labels: collectLabels((await readScreen()).root) };
        } catch (e) {
          return { labels: [], error: String(e) };
        }
      },
    }),

    triggerOnce: defineAction({
      title: "Trigger Once",
      description: "立即尝试点击当前通话界面的录音按钮",
      run: async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20_000);
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
