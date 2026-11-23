import * as accessibility from "@swipt/api/accessibility";
import type {
  AccessibilityElement,
  AccessibilitySnapshot,
} from "@swipt/api/accessibility";
import * as device from "@swipt/api/device";
import * as fs from "@swipt/api/file-system";
import * as proc from "@swipt/api/process";
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

// 电话相关 bundleId（iOS 的通话界面归属在 SpringBoard 下）
const phoneBundleIds = new Set([
  "com.apple.mobilephone",
  "com.apple.InCallService",
  "com.apple.CoreTelephony",
  "com.apple.CallKitService",
  "com.apple.Phone",
  "com.apple.TelephonyUtilities",
]);

// 只有这几种前台才可能显示通话界面：电话 App / CallKit 服务 / SpringBoard（通话界面由它承载）
const callFrontApps = new Set<string>([...phoneBundleIds, "com.apple.springboard"]);

// ===== 行为参数 =====
const STABILIZE_MS = 1000; // 通话界面出现后等待稳定
const MENU_OPEN_MS = 700; // 点击「更多」后等菜单弹出
const FIND_TIMEOUT_MS = 4000; // 找按钮的最长等待
const FIND_POLL_MS = 600; // 找按钮时的重读间隔
const ATTEMPT_COOLDOWN_MS = 8000; // 一次失败后的冷却
const MAX_ATTEMPTS_PER_CALL = 3; // 每通电话最多尝试次数
const RECORD_TAP_RETRIES = 3; // 点「通话录音」没生效时的重试次数
const RECORD_CONFIRM_MS = 700; // 点完只看一眼菜单是否收起

// ===== 探测策略（1.0.6）=====
// 1.0.2~1.0.4：用 accessibility.find(不带 poll) 当等待，屏幕有元素增删就重读整棵树，
//             滚动/动画/打字时约 80 次/分钟，SpringBoard 渲染被拖住 → 掉帧。
// 1.0.5：只等 App 事件，但事件里含 SpringBoard（每次回桌面都触发），且一次事件连读 8 遍全树；
//        同时通话界面出现时往往没有 App 事件 → 既卡顿又漏点。
// 1.0.6：周期探测改为「浅层快照」（depth 控制节点数），间隔按场景调整；
//        事件只作加速（仅电话类 App），前台/屏幕状态用推送订阅，零轮询。
const L1_DEPTH = 30; // 探测深度：通话界面按钮在 8~14 层，30 足够且省掉深层装饰节点
const L1_FAST_MS = 3000; // 电话类 App 在前台：3 秒一探
const L1_HOME_MS = 6000; // 主屏（SpringBoard）在前台：6 秒一探
const L1_QUIET_MS = 5000; // 已点过录音：只需发现"通话界面消失"，好接下一通
const IDLE_WAIT_MS = 30_000; // 前台是别的 App：只等推送，30 秒兜底一次
const HOT_MISS_LIMIT = 4; // 连续这么多次探不到，就认为刚才的电话活动不是通话
const PHONE_HOT_MS = 30_000; // 电话类活动后这段时间内算"热"
const EVENT_THROTTLE_MS = 1500; // 两次探测之间的最小间隔
const FALSE_HIT_BACKOFF_MS = 1200;

const LOG_MAX_CHARS = 32 * 1024;
const LOG_FLUSH_MS = 2000;

// ===== 通话会话状态 =====
// quiet：非 null 表示本通已处理过，别重复点。
//  - "recording"：已点过录音
//  - "exhausted"：本通重试次数用尽
type QuietReason = "recording" | "exhausted";
interface CallSession {
  quiet: QuietReason | null;
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

// 运行统计（不落盘，readLog 时带出来）
const stats = {
  probes: 0,
  probeMs: 0,
  lastProbeMs: 0,
  hits: 0,
  taps: 0,
  skipped: 0,
};

// 设备端 Swipt 版本可能不支持某些参数/状态，启动时探测一次，不支持就退回全树读取。
let depthSupported = true;
let foregroundSupported = true;
let displayOn = true;
let foreground: string | null = null;
let lastPhoneActivityAt = 0;
let hotMisses = 0;
let lastProbeAt = 0;

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

// ===== 无障碍树工具 =====
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

// 完整读取：只在确认通话后使用（点击阶段）
async function readScreen(options?: {
  depth?: number;
  signal?: AbortSignal;
}): Promise<AccessibilitySnapshot> {
  return accessibility.snapshot({
    scope: "fullScreen",
    full: true,
    ...(options?.depth !== undefined ? { depth: options.depth } : {}),
    ...(options?.signal !== undefined ? { signal: options.signal } : {}),
  });
}

// 浅层读取：周期探测用。不带 full（不需要 raw 属性），depth 也做了截断，
// 单次跨进程拷贝比整棵全属性树轻得多。
// 老版本 Swipt 不认识 depth（strict 校验会直接报错），探测失败后自动退回全树。
async function readLite(signal?: AbortSignal): Promise<AccessibilitySnapshot> {
  if (!depthSupported) {
    return accessibility.snapshot({
      scope: "fullScreen",
      ...(signal !== undefined ? { signal } : {}),
    });
  }
  return accessibility.snapshot({
    scope: "fullScreen",
    depth: L1_DEPTH,
    ...(signal !== undefined ? { signal } : {}),
  });
}

// 启动时确认 depth 参数被接受
async function probeCapabilities(): Promise<void> {
  try {
    await accessibility.snapshot({ scope: "fullScreen", depth: L1_DEPTH });
  } catch (error) {
    depthSupported = false;
    await writeLog(
      `当前 Swipt 版本不支持 depth 参数，退回全树探测: ${error}`,
    );
  }
}

function watchable(state: unknown): boolean {
  return (
    typeof state === "object" &&
    state !== null &&
    typeof (state as { values?: unknown }).values === "function"
  );
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
    const snapshot = await readScreen();
    const lines: string[] = [
      `--- ${prefix} ---`,
      `前台应用: ${foreground ?? "(未知)"}`,
      "无障碍树:",
    ];
    collectElements(snapshot.root, 0, lines);
    await writeLog(lines.join("\n"));
  } catch (e) {
    await writeLog(`${prefix} 截取无障碍树失败: ${e}`);
  }
}

// ===== 判定 =====
// 通话界面的判据：不能只看「更多」，那在别的 App 里到处都是。
//  - 有「结束/挂断」→ 基本就是通话界面
//  - 有「静音」且同时有「更多」→ 通话界面（很多 App 只有其一）
//  - 有「停止录音」→ 正在录音的通话
function looksLikeCall(root: AccessibilityElement): boolean {
  if (hasLabel(root, isCallEndLabel)) return true;
  if (hasLabel(root, isStopRecordLabel)) return true;
  return hasLabel(root, isMuteLabel) && hasLabel(root, isMoreLabel);
}

type ProbeResult =
  | { kind: "none" }
  | { kind: "call" }
  | { kind: "recording" };

// 浅层探测：单次快照 + 极小的递归判断
async function probeLite(signal?: AbortSignal): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const snapshot = await readLite(signal);
    const root = snapshot.root;
    // 快照自带前台 bundleId，顺手校准一次：前台已经不在白名单就白读了
    if (foregroundSupported && !callFrontApps.has(snapshot.app)) {
      foreground = snapshot.app;
      stats.probes++;
      stats.lastProbeMs = Date.now() - started;
      stats.probeMs += stats.lastProbeMs;
      return { kind: "none" };
    }
    stats.probes++;
    stats.lastProbeMs = Date.now() - started;
    stats.probeMs += stats.lastProbeMs;
    if (hasLabel(root, isStopRecordLabel)) return { kind: "recording" };
    if (looksLikeCall(root)) return { kind: "call" };
    return { kind: "none" };
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    stats.probes++;
    stats.lastProbeMs = Date.now() - started;
    return { kind: "none" };
  }
}

async function isAlreadyRecording(signal?: AbortSignal): Promise<boolean> {
  try {
    return hasLabel((await readScreen({ signal })).root, isStopRecordLabel);
  } catch {
    return false;
  }
}

// 录音 UI 的三种状态：正在录音 / 「更多」菜单还开着 / 两者都没有
type RecordUiState = "recording" | "menu" | "plain";

async function readRecordUiState(signal?: AbortSignal): Promise<RecordUiState> {
  try {
    const root = (await readScreen({ signal })).root;
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
        collectLabeled((await readScreen({ signal })).root, test),
      );
      if (picked !== null) return picked;
    } catch (error) {
      if (signal.aborted || (error as Error).name === "AbortError") throw error;
    }
    if (Date.now() >= deadline) return null;
    await sleep(FIND_POLL_MS, { signal });
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
  stats.taps++;
  await writeLog(`已点击「${element.label ?? name}」`);
  return true;
}

// ===== 触发录音，成功返回 true =====
async function recordCall(
  signal: AbortSignal,
  options?: { knownRecording?: boolean },
): Promise<boolean> {
  if (!options?.knownRecording && (await isAlreadyRecording(signal))) {
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
    if (!(await tapByLabel(isRecordLabel, "通话录音/通話錄音", signal))) {
      break;
    }
    await sleep(RECORD_CONFIRM_MS, { signal });
    const state = await readRecordUiState(signal);
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

// ===== 等待：定时器 + 事件可提前唤醒 =====
let wakeUp: (() => void) | null = null;
let pendingWake = false;

function signalActivity() {
  const resolve = wakeUp;
  if (resolve === null) {
    // 正在探测/点击时到来的事件不能丢，留给下一轮立刻处理
    pendingWake = true;
    return;
  }
  wakeUp = null;
  resolve();
}

type WakeReason = "event" | "timer";

function waitForWake(signal: AbortSignal, timeoutMs: number): Promise<WakeReason> {
  if (pendingWake) {
    pendingWake = false;
    return Promise.resolve("event");
  }
  return new Promise<WakeReason>((resolve, reject) => {
    let settled = false;
    const finish = (reason: WakeReason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      wakeUp = null;
      resolve(reason);
    };
    const timer = setTimeout(() => finish("timer"), timeoutMs);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      wakeUp = null;
      reject(abortError());
    };
    wakeUp = () => finish("event");
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// 前台不是通话相关 App 时，一次屏都不读——电话不会凭空出现在微信界面上。
// 订阅不可用（老版本 Swipt）或前台未知时保守放行。
function shouldProbe(): boolean {
  if (!foregroundSupported) return true;
  if (foreground === null) return true;
  return callFrontApps.has(foreground);
}

// 当前该用多慢的节奏探测
function probeInterval(): number {
  if (!shouldProbe()) return IDLE_WAIT_MS;
  if (session.quiet !== null) return L1_QUIET_MS;
  if (Date.now() - lastPhoneActivityAt < PHONE_HOT_MS) return L1_FAST_MS;
  if (foreground === "com.apple.springboard") return L1_HOME_MS;
  return L1_FAST_MS;
}

// ===== 处理一通电话 =====
async function handleCall(signal: AbortSignal, recording: boolean) {
  if (recording) {
    if (session.quiet === null) {
      session.quiet = "recording";
      await writeLog("界面已在录音中，视为本通已处理");
    }
    return;
  }

  // 本通已经点过（或放弃）：不再动它
  if (session.quiet !== null) return;
  if (session.busy) return;

  if (session.attempts >= MAX_ATTEMPTS_PER_CALL) {
    session.quiet = "exhausted";
    return;
  }

  const recent = Date.now() - session.lastAttemptAt < ATTEMPT_COOLDOWN_MS;
  if (recent) return;

  session.busy = true;
  session.attempts++;
  session.lastAttemptAt = Date.now();
  stats.hits++;
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
        await writeLog("本通电话暂不重试，等待下一通");
      }
    }
  } catch (error) {
    if ((error as Error).name !== "AbortError") {
      await writeLog(`触发录音失败: ${error}`);
    }
  } finally {
    session.busy = false;
  }
}

// ===== 唯一的执行循环 =====
async function watchCalls(signal: AbortSignal) {
  await writeLog("通话监听已启动（1.0.7：只在电话类 App 前台时读屏）");
  while (!signal.aborted) {
    try {
      const interval = probeInterval();
      const reason = await waitForWake(signal, interval);
      if (signal.aborted) return;

      // 熄屏不读：夜间/口袋里的读屏纯属浪费
      if (!displayOn) {
        stats.skipped++;
        continue;
      }
      // 前台不是电话类 App：不可能显示通话界面，跳过这一次读屏
      if (!shouldProbe()) {
        stats.skipped++;
        continue;
      }

      // 事件可能连发（切 App、亮屏），探测本身有成本，压到 1.5 秒一次
      if (reason === "event") {
        const gap = Date.now() - lastProbeAt;
        if (gap < EVENT_THROTTLE_MS) {
          await sleep(EVENT_THROTTLE_MS - gap, { signal });
        }
      }

      lastProbeAt = Date.now();
      const probe = await probeLite(signal);
      if (probe.kind === "none") {
        // 只是打开了电话 App / 从电话 App 退出来：探测几轮没有通话特征就退出"热"状态
        if (Date.now() - lastPhoneActivityAt < PHONE_HOT_MS) {
          hotMisses++;
          if (hotMisses >= HOT_MISS_LIMIT) lastPhoneActivityAt = 0;
        }
        if (session.quiet !== null) {
          await writeLog("通话已结束，回到空闲探测");
          session.quiet = null;
          session.attempts = 0;
        }
        continue;
      }

      lastPhoneActivityAt = Date.now();
      hotMisses = 0;
      await handleCall(signal, probe.kind === "recording");
    } catch (error) {
      if (signal.aborted || (error as Error).name === "AbortError") return;
      await writeLog(`处理出错: ${error}`);
      await sleep(FALSE_HIT_BACKOFF_MS, { signal });
    }
  }
}

// ===== 订阅：App 事件 / 前台 App / 屏幕状态（全部推送，零轮询）=====
async function watchApplicationEvents(signal: AbortSignal) {
  for await (const event of device.applicationEvents({ signal })) {
    if (signal.aborted) return;
    if (!phoneBundleIds.has(event.bundleId)) continue;
    lastPhoneActivityAt = Date.now();
    signalActivity();
  }
}

async function watchForeground(signal: AbortSignal) {
  for await (const app of device.foregroundApplication.values({ signal })) {
    if (signal.aborted) return;
    const changed = app !== foreground;
    foreground = app;
    if (changed && phoneBundleIds.has(app)) {
      lastPhoneActivityAt = Date.now();
    }
    if (changed) signalActivity();
  }
}

async function watchDisplay(signal: AbortSignal) {
  for await (const state of device.displayState.values({ signal })) {
    if (signal.aborted) return;
    const wasOn = displayOn;
    displayOn = state === "activeOn" || state === "inactiveOn";
    if (displayOn && !wasOn) signalActivity();
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
    await writeLog("========== 服务已启动 (1.0.7) ==========");

    await probeCapabilities();

    try {
      foreground = await device.foregroundApplication.get({ signal });
    } catch {}
    try {
      const state = await device.displayState.get({ signal });
      displayOn = state !== "off";
    } catch {}

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

    const tasks = [
      supervise("触发流程", () => watchCalls(signal)),
      supervise("应用事件监听", () => watchApplicationEvents(signal)),
    ];
    if (watchable(device.foregroundApplication)) {
      tasks.push(supervise("前台 App 监听", () => watchForeground(signal)));
    } else {
      foregroundSupported = false;
      await writeLog("当前 Swipt 版本不支持前台 App 订阅，退回全时探测");
    }
    if (watchable(device.displayState)) {
      tasks.push(supervise("屏幕状态监听", () => watchDisplay(signal)));
    } else {
      await writeLog("当前 Swipt 版本不支持屏幕状态订阅，熄屏节流不生效");
    }
    await Promise.all(tasks);

    await flushLog();
  },

  actions: {
    inspect: defineAction({
      title: "Inspect Current Screen",
      description: "打印当前无障碍树，用于调试",
      run: async () => {
        const snapshot = await readScreen();
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

    // 一次性定标：不同 depth 的耗时 + 当前是否命中通话锚点
    // 在通话界面运行一次，就能知道浅层探测该用多深。
    diag: defineAction({
      title: "Diagnose",
      description: "测量不同读取深度的耗时，并列出与通话相关的进程",
      run: async () => {
        const depths = [8, 16, 24, 32, 40];
        const probe: Record<string, unknown>[] = [];
        for (const depth of depths) {
          const started = Date.now();
          try {
            const snapshot = await accessibility.snapshot({
              scope: "fullScreen",
              depth,
            });
            probe.push({
              depth,
              ms: Date.now() - started,
              labels: collectLabels(snapshot.root).length,
              end: hasLabel(snapshot.root, isCallEndLabel),
              mute: hasLabel(snapshot.root, isMuteLabel),
              more: hasLabel(snapshot.root, isMoreLabel),
              record: hasLabel(snapshot.root, isRecordLabel),
              stop: hasLabel(snapshot.root, isStopRecordLabel),
            });
          } catch (e) {
            probe.push({ depth, error: String(e) });
          }
        }
        const fullStarted = Date.now();
        let fullMs = -1;
        let fullLabels = 0;
        try {
          const snapshot = await readScreen();
          fullMs = Date.now() - fullStarted;
          fullLabels = collectLabels(snapshot.root).length;
        } catch {}

        let processes: string[] = [];
        try {
          const list = await proc.list();
          processes = list
            .map((entry) => entry.bundleId ?? entry.executablePath ?? "")
            .filter((path) => path !== "")
            .filter((path) => /phone|call|telephon|InCall/i.test(path))
            .slice(0, 40);
        } catch (e) {
          processes = [`(读取进程失败: ${e})`];
        }

        return {
          foreground,
          displayOn,
          probe,
          full: { ms: fullMs, labels: fullLabels },
          stats: {
            ...stats,
            averageProbeMs:
              stats.probes > 0 ? Math.round(stats.probeMs / stats.probes) : 0,
          },
          phoneProcesses: processes,
        };
      },
    }),

    triggerOnce: defineAction({
      title: "Trigger Once",
      description: "立即尝试点击当前通话界面的录音按钮",
      run: async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20_000);
        try {
          const ok = await recordCall(controller.signal, {
            knownRecording: false,
          });
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
          return {
            log: await file.text(),
            stats: {
              ...stats,
              averageProbeMs:
                stats.probes > 0 ? Math.round(stats.probeMs / stats.probes) : 0,
            },
          };
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
