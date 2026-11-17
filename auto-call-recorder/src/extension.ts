import * as accessibility from "@swipt/api/accessibility";
import type { AccessibilityElement } from "@swipt/api/accessibility";
import * as device from "@swipt/api/device";
import * as fs from "@swipt/api/file-system";
import { defineAction, defineExtension } from "@swipt/api/swiplet";

// 电话相关 bundleId
// 注意：iOS 通话界面归属在 com.apple.springboard 下
const phoneBundleIds = new Set([
  "com.apple.springboard",
  "com.apple.mobilephone",
  "com.apple.InCallService",
  "com.apple.CoreTelephony",
  "com.apple.CallKitService",
  "com.apple.Phone",
  "com.apple.TelephonyUtilities",
]);

// 按钮文本
const MORE_LABEL = "更多";
const RECORD_LABEL = "通话录音";
const STOP_RECORD_LABEL = "停止通话录音";
const CALL_APP_LABEL = "电话";

// 每次通话只触发一次录音
const activeCalls = new Map<number | string, AbortController>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeLog(text: string) {
  try {
    const dir = fs.dataDirectory;
    const file = dir.file("debug.log");
    let existing = "";
    try {
      existing = await file.text();
    } catch {}
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] ${text}\n`;
    await file.write(existing + entry);
  } catch (e) {
    console.error("[auto-call-recorder] 写日志失败:", e);
  }
}

async function dumpScreenToLog(prefix: string) {
  try {
    const foreground = await device.foregroundApplication.get();
    const snapshot = await accessibility.snapshot({ full: true });
    const lines: string[] = [];
    lines.push(`--- ${prefix} ---`);
    lines.push(`前台应用: ${JSON.stringify(foreground)}`);
    lines.push(`无障碍树:`);
    collectElements(snapshot.root, 0, lines);
    await writeLog(lines.join("\n"));
  } catch (e) {
    await writeLog(`${prefix} 截取无障碍树失败: ${e}`);
  }
}

function collectElements(el: AccessibilityElement, depth: number, out: string[]) {
  const indent = "  ".repeat(depth);
  const parts: string[] = [];
  if (el.role) parts.push(`role=${el.role}`);
  if (el.label) parts.push(`label="${el.label}"`);
  if (el.value) parts.push(`value="${el.value}"`);
  if (el.frame) parts.push(`frame=[${el.frame.join(",")}]`);
  if (el.traits?.length) parts.push(`traits=[${el.traits.join(",")}]`);
  if (parts.length) {
    out.push(`${indent}${parts.join(" ")}`);
  }
  for (const child of el.children) {
    collectElements(child, depth + 1, out);
  }
}

// 检查当前界面是否为通话界面
async function isCallActive(): Promise<boolean> {
  try {
    const snapshot = await accessibility.snapshot({ full: true });
    const root = snapshot.root;

    // 检查 application label 是否为「电话」
    if (root.label === CALL_APP_LABEL) {
      return true;
    }

    // 检查是否有通话相关按钮
    const hasCallButtons = hasElement(root, "结束") || hasElement(root, "静音");
    const hasMoreButton = hasElement(root, MORE_LABEL);
    if (hasCallButtons && hasMoreButton) {
      return true;
    }

    // 检查是否已经在录音（有「停止通话录音」按钮）
    if (hasElement(root, STOP_RECORD_LABEL)) {
      return true;
    }
  } catch {}
  return false;
}

function hasElement(el: AccessibilityElement, label: string): boolean {
  if (el.label === label) return true;
  for (const child of el.children) {
    if (hasElement(child, label)) return true;
  }
  return false;
}

// 检查是否已经在录音
async function isAlreadyRecording(): Promise<boolean> {
  try {
    const snapshot = await accessibility.snapshot({ full: true });
    return hasElement(snapshot.root, STOP_RECORD_LABEL);
  } catch {}
  return false;
}

async function tapElement(
  element: AccessibilityElement,
  label: string,
  signal: AbortSignal,
) {
  if (!element.frame) {
    await writeLog(`${label} 没有位置信息`);
    return false;
  }
  await accessibility.tap(element, { signal });
  await writeLog(`已点击 ${label}`);
  return true;
}

async function findAndTap(
  selector: accessibility.AccessibilitySelector,
  label: string,
  options: { timeoutMs: number; signal: AbortSignal },
) {
  await writeLog(`查找 ${label}...`);
  const element = await accessibility.find(selector, {
    timeoutMs: options.timeoutMs,
    poll: true,
    signal: options.signal,
  });
  if (!element) {
    await writeLog(`未找到 ${label}`);
    return false;
  }
  return tapElement(element, label, options.signal);
}

async function recordCall(bundleId: string, pid: number, signal: AbortSignal) {
  await writeLog(`检测到通话界面: ${bundleId} pid ${pid}`);

  // 先把当前界面元素写入日志
  await dumpScreenToLog(`通话开始 ${bundleId}`);

  // 等待通话界面稳定
  await sleep(1500);
  if (signal.aborted) return;

  // 检查是否已经在录音了
  if (await isAlreadyRecording()) {
    await writeLog("已经在录音中，无需重复点击");
    return;
  }

  // 第一步：点击「更多」
  const moreTapped = await findAndTap(
    { label: MORE_LABEL },
    MORE_LABEL,
    { timeoutMs: 4000, signal },
  );
  if (!moreTapped) {
    await writeLog("「更多」按钮未找到，停止");
    return;
  }

  // 等待菜单弹出
  await sleep(800);
  if (signal.aborted) return;

  // 点击「更多」后再次截图
  await dumpScreenToLog(`点击更多后`);

  // 第二步：点击「通话录音」
  const recordTapped = await findAndTap(
    { label: RECORD_LABEL },
    RECORD_LABEL,
    { timeoutMs: 4000, signal },
  );

  if (recordTapped) {
    await writeLog(`自动录音已触发`);
  } else {
    await writeLog(`「通话录音」按钮未找到`);
  }
}

async function watchByApplicationEvents(signal: AbortSignal) {
  await writeLog("监听应用前台事件已启动");
  try {
    for await (const event of device.applicationEvents({ signal })) {
      if (!phoneBundleIds.has(event.bundleId)) {
        continue;
      }

      const running = activeCalls.get(event.pid);

      if (event.type === "background") {
        if (running) {
          running.abort();
          activeCalls.delete(event.pid);
          await writeLog(`通话结束: ${event.bundleId}`);
        }
        continue;
      }

      if (running) {
        continue;
      }

      if (event.type === "foreground" || event.type === "launch") {
        const controller = new AbortController();
        activeCalls.set(event.pid, controller);

        recordCall(event.bundleId, event.pid, controller.signal).catch(
          async (error: Error) => {
            if (error.name !== "AbortError") {
              await writeLog(`录音失败: ${error}`);
            }
          },
        );
      }
    }
  } catch (error) {
    await writeLog(`applicationEvents 出错: ${error}`);
  }
}

async function watchByPolling(signal: AbortSignal) {
  await writeLog("轮询检测已启动（备用）");
  let wasCallActive = false;

  while (!signal.aborted) {
    try {
      const callActive = await isCallActive();

      if (callActive && !wasCallActive) {
        // 通话刚开始
        const foreground = await device.foregroundApplication.get();
        const bundleId = foreground?.bundleId ?? "unknown";
        const pid = foreground?.pid ?? 0;
        const key = pid || bundleId;

        if (!activeCalls.has(key)) {
          const controller = new AbortController();
          activeCalls.set(key, controller);
          wasCallActive = true;

          recordCall(bundleId, pid, controller.signal).catch(
            async (error: Error) => {
              if (error.name !== "AbortError") {
                await writeLog(`录音失败: ${error}`);
              }
            },
          );
        }
      } else if (!callActive && wasCallActive) {
        // 通话结束
        wasCallActive = false;
        for (const [key, controller] of activeCalls) {
          controller.abort();
          activeCalls.delete(key);
          await writeLog(`通话结束（轮询检测）`);
        }
      }
    } catch (error) {
      await writeLog(`轮询出错: ${error}`);
    }
    await sleep(1000);
  }
}

export default defineExtension({
  async run({ signal }) {
    await writeLog("========== 服务已启动 ==========");

    // 同时监听应用事件和轮询前台应用
    await Promise.race([
      watchByApplicationEvents(signal),
      watchByPolling(signal),
    ]);
  },

  actions: {
    inspect: defineAction({
      title: "Inspect Current Screen",
      description: "打印当前无障碍树，用于调试",
      run: async () => {
        const snapshot = await accessibility.snapshot({ full: true });
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
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
          await recordCall("manual", 0, controller.signal);
          return { ok: true };
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
          const text = await file.text();
          return { log: text };
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
          const file = fs.dataDirectory.file("debug.log");
          await file.write("");
          return { cleared: true };
        } catch {
          return { cleared: false };
        }
      },
    }),
  },
});

function simplifyTree(element: AccessibilityElement, depth = 0): unknown {
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
