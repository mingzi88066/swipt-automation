// 示例：打开设置，点击某个菜单项
await device.launchApplication("com.apple.Preferences");
await sleep(1500);

// 通过文本查找元素并点击
const wifiItem = await accessibility.find({ label: "无线局域网" }, { timeoutMs: 5000 });
if (wifiItem) {
  await accessibility.tap(wifiItem);
  console.log("已点击 无线局域网");
} else {
  console.log("未找到 无线局域网");
}

// 支持更多选择器：
// const el = await accessibility.find({
//   role: "按钮",
//   label: /搜索/,
//   traits: ["button"],
//   disabled: false,
// });
