// 示例：在搜索框中输入文字并搜索
// 假设当前已打开 Safari，且地址栏可聚焦

// 找到搜索/输入框
const searchField = await accessibility.find(
  { role: "搜索栏" },
  { timeoutMs: 5000 }
);

if (searchField) {
  // 点击搜索框
  await accessibility.tap(searchField);
  await sleep(500);

  // 输入文字
  await accessibility.setText(searchField, "swipt ios automation");
  await sleep(500);

  // 按回车键
  await input.pressKey("return");
  console.log("已输入并提交搜索");
} else {
  console.log("未找到搜索栏");
}
