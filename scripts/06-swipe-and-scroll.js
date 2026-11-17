// 示例：滑动和滚动查找元素

// 方法 1：基于坐标滑动（从屏幕中间向下滑动）
const { width, height } = (await device.info()).screen;
await input.swipe([width / 2, height * 0.7], [width / 2, height * 0.3], {
  durationMs: 500,
});

// 方法 2：对可滚动元素执行滚动动作
await sleep(1000);
const list = await accessibility.find({ role: "列表" });
if (list) {
  await accessibility.perform(list, "scrollDown");
}

// 方法 3：滚动直到找到元素
const target = await accessibility.find(
  { label: "通用" },
  { timeoutMs: 10000, poll: true }
);
if (target) {
  await accessibility.tap(target);
}
