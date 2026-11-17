import * as accessibility from "@swipt/api/accessibility";
import type { AccessibilityElement } from "@swipt/api/accessibility";
import * as device from "@swipt/api/device";
import { defineAction, defineExtension } from "@swipt/api/swiplet";

// 可能的电话相关 bundleId。
// 注意：实际 bundleId 因 iOS 版本和通话场景而异，建议先用调试动作确认。
const phoneBundleIds = new Set([
  "com.apple.mobilephone",
  "com.apple.InCallService",
  "com.apple.CoreTelephony",
  "com.apple.CallKitService",
]);

// 按钮文本（根据你的系统语言调整）
const MORE_LABEL = "更多";
const RECORD_LABEL = "通话录音";

// 每次通话只触发一次录音
const activeCalls = new Map<number, AbortController>();

function centerOf(frame: NonNullable<AccessibilityElement["frame"]>) {
  const [x, y, width, height] = frame;
  return [x + width / 2, y + height / 2] as [number, number];
}

async function tapElement(
  element: AccessibilityElement,
  label: string,
  signal: AbortSignal,
) {
  if (!element.frame) {
    console.warn(`[auto-call-recorder] ${label} 没有位置信息`);
    return false;
  }
  await accessibility.tap(element, { signal });
  console.log(`[auto-call-recorder] 已点击 ${label}`);
  return true;
}

async function findAndTap(
  selector: accessibility.AccessibilitySelector,
  label: string,
  options: { timeoutMs: number; signal: AbortSignal },
) {
  console.log(`[auto-call-recorder] 查找 ${label}...`);
  const element = await accessibility.find(selector, {
    timeoutMs: options.timeoutMs,
    poll: true,
    signal: options.signal,
  });
  if (!element) {
    console.warn(`[auto-call-recorder] 未找到 ${label}`);
    return false;
  }
  return tapElement(element, label, options.signal);
}

async function recordCall(bundleId: string, pid: number, signal: AbortSignal) {
  console.log(`[auto-call-recorder] 检测到通话界面: ${bundleId} pid ${pid}`);

  // 等待通话界面稳定
  await sleep(800);
  if (signal.aborted) return;

  // 第一步：点击「更多」
  const moreTapped = await findAndTap(
    { label: MORE_LABEL },
    MORE_LABEL,
    { timeoutMs: 3000, signal },
  );
  if (!moreTapped) return;

  // 等待菜单弹出
  await sleep(600);
  if (signal.aborted) return;

  // 第二步：点击「通话录音」
  const recordTapped = await findAndTap(
    { label: RECORD_LABEL },
    RECORD_LABEL,
    { timeoutMs: 3000, signal },
  );

  if (recordTapped) {
    console.log(`[auto-call-recorder] 自动录音已触发`);
  }
}

export default defineExtension({
  async run({ signal }) {
    console.log("[auto-call-recorder] 服务已启动");

    for await (const event of device.applicationEvents({ signal })) {
      if (!phoneBundleIds.has(event.bundleId)) {
        continue;
      }

      const running = activeCalls.get(event.pid);

      if (event.type === "background") {
        if (running) {
          running.abort();
          activeCalls.delete(event.pid);
          console.log(`[auto-call-recorder] 通话结束: ${event.bundleId}`);
        }
        continue;
      }

      // 避免同一个通话重复触发
      if (running) {
        continue;
      }

      if (event.type === "foreground" || event.type === "launch") {
        const controller = new AbortController();
        activeCalls.set(event.pid, controller);

        recordCall(event.bundleId, event.pid, controller.signal).catch(
          (error: Error) => {
            if (error.name !== "AbortError") {
              console.error("[auto-call-recorder] 录音失败:", error);
            }
          },
        );
      }
    }
  },

  actions: {
    // 调试用：列出当前界面元素，帮助确认按钮文本和 bundleId
    inspect: defineAction({
      title: "Inspect Current Screen",
      description: "打印当前无障碍树，用于调试",
      run: async () => {
        const snapshot = await accessibility.snapshot({ full: true });
        const foreground = await device.foregroundApplication.get();
        return {
          app: foreground,
          tree: simplifyTree(snapshot.root),
        };
      },
    }),

    // 调试用：直接尝试点击一次「更多」→「通话录音」
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
  },
});

// 简化无障碍树用于调试输出
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
