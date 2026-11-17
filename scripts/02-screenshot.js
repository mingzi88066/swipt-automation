// 截图并保存到 REPL 数据目录
const image = await device.screenshot();
const outputFile = dataDirectory.file("screenshot.png");
await image.copy(outputFile);
console.log("截图已保存:", outputFile.uri);

// 如果要直接获取 base64 或 bytes 做后续处理：
// const bytes = await image.bytes();
