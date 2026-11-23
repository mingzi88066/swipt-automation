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

// ===== 性能参数（1.0.5：彻底取消"跟屏幕推送读整棵树"）=====
// 1.0.4 及以前用 accessibility.find(..., timeoutMs: Infinity) 当空闲等待，
// 它的语义是「每来一次屏幕变化推送就重新读一遍整棵无障碍树」——
// 只要屏幕在动（滚动、动画、打字），就变成每秒一次跨进程全树拷贝，
// 直接卡住 SpringBoard，这就是"用完之后掉帧"的根因。
// 现在空闲期完全不读屏：只等 App 事件（零成本），外加低频看门狗单次读屏兜底。
const IDLE_WATCHDOG_MS = 20_000; // 空闲时兜底检查间隔（1 次读屏 / 20 秒）
const QUIET_WATCHDOG_MS = 60_000; // 挂起后更懒（1 次读屏 / 1 分钟）
const EVENT_PROBE_TRIES = 8; // 事件唤醒后最多探几次通话界面
const PROBE_INTERVAL_MS = 600; // 每次探测的间隔
const FALSE_HIT_BACKOFF_MS = 1500; // 误判后重新挂起等待的间隔
const LOG_MAX_CHARS = 32 * 1024;
const LOG_FLUSH_MS = 2000;

// ===== 通话会话状态 =====
// quiet：挂起原因。非 null 表示当前完全不读屏，只等事件 / 看门狗唤醒。
//  - "recording"：本通已点过录音，等下一通电话
//  - "exhausted"：本通重试次数用尽，唤醒后允许再试一次
type QuietReason = "recording" | "exhausted";
interface CallSession {
  quiet: QuietReason | null; // 非 null 表示本通已处理完，挂起中
  attempts: number;
  lastAttemptAt: number;
  busy: boolean;
}
const session: CallSession = {
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

// ===== 空闲/挂起等待：零读屏，只等 App 事件 =====
// 事件流由 watchByApplicationEvents 推进，这里只挂一个可能被事件提前唤醒的定时器。
let wakeUp: (() => void) | null = null;

function signalPhoneActivity() {
  const resolve = wakeUp;
  wakeUp = null;
  resolve?.();
}

type WakeReason = "event" | "watchdog";

async function waitForActivity(
  signal: AbortSignal,
  timeoutMs: number,
): Promise<WakeReason> {
  const wake = new Promise<WakeReason>((resolve) => {
    wakeUp = () => resolve("event");
  });
  const watchdog: Promise<WakeReason> = sleep(timeoutMs, { signal }).then(
    () => "watchdog" as WakeReason,
    () => "watchdog" as WakeReason,
  );
  try {
    return await Promise.race([wake, watchdog]);
  } finally {
    wakeUp = null;
  }
}

// 被唤醒后最多探 tries 次，等通话界面动画到位；tries = 1 就是单次读屏
async function probeCallScreen(
  tries: number,
  signal: AbortSignal,
): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await isCallScreen()) return true;
    if (i + 1 >= tries) break;
    await sleep(PROBE_INTERVAL_MS, { signal });
  }
  return false;
}

// 被唤醒后走一次判定 + 触发流程；返回 true 表示当前确实在处理一通电话
async function handleCallIfAny(
  signal: AbortSignal,
  probeTries: number,
): Promise<boolean> {
  // 已挂起（本通处理过）时只需要判断"通话界面还在吗"，探一次就够
  const tries = session.quiet !== null ? 1 : probeTries;
  if (!(await probeCallScreen(tries, signal))) {
    if (session.quiet !== null) {
      await writeLog("通话已结束，回到挂起等待");
    }
    session.quiet = null;
    session.attempts = 0;
    return false;
  }

  // 本通已经点过录音（或已放弃）：绝不再点，安安静静等它结束。
  // 判断"新的一通"只依据"通话界面消失"，不依据"停止录音"文案——
  // 录音中的通话主界面并不会一直显示「停止通话录音」，靠它判断会误判成新电话。
  if (session.quiet !== null) {
    return true;
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

// ===== 唯一的执行循环：零读屏等待 → 被唤醒 → 判定 → 再等待 =====
async function watchCalls(signal: AbortSignal) {
  await writeLog("通话监听已启动（1.0.5：空闲零读屏，仅事件唤醒）");
  while (!signal.aborted) {
    const timeout =
      session.quiet !== null ? QUIET_WATCHDOG_MS : IDLE_WATCHDOG_MS;
    const reason = await waitForActivity(signal, timeout);
    if (signal.aborted) return;
    try {
      const handled = await handleCallIfAny(
        signal,
        reason === "event" ? EVENT_PROBE_TRIES : 1,
      );
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
    await writeLog("========== 服务已启动 (1.0.5) ==========");

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
