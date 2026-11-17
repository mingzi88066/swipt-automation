// 启动应用（使用 bundleId）
const bundleId = "com.apple.mobilesafari"; // Safari
await device.launchApplication(bundleId, { restart: false });
console.log(`已启动应用: ${bundleId}`);

// 等待应用真正到达前台
await new Promise((resolve) => {
  const unsub = device.foregroundApplication.values().then(async (stream) => {
    for await (const app of stream) {
      if (app === bundleId) {
        console.log("应用已到达前台:", app);
        resolve();
        break;
      }
    }
  });
});

// 稍等界面稳定
await sleep(1500);
const image = await device.screenshot();
await image.copy(dataDirectory.file("safari-launch.png"));
