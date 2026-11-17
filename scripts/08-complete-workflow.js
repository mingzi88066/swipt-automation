// 完整工作流示例：解锁设备 -> 打开 App -> 操作 -> 截图

async function unlockIfNeeded() {
  const locked = await device.locked.get();
  if (locked) {
    await device.unlock();
    await sleep(1000);
  }
}

async function openApp(bundleId) {
  await device.launchApplication(bundleId, { restart: true });
  await sleep(2000);
}

async function tapByLabel(label, timeoutMs = 5000) {
  const el = await accessibility.find({ label }, { timeoutMs });
  if (!el) throw new Error(`未找到元素: ${label}`);
  await accessibility.tap(el);
}

async function main() {
  await unlockIfNeeded();
  await openApp("com.apple.Preferences");
  await tapByLabel("无线局域网");
  await sleep(1000);

  const image = await device.screenshot();
  await image.copy(dataDirectory.file("wifi-page.png"));
  console.log("工作流完成，截图已保存");
}

await main();
