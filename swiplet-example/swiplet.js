// 一个最小化的 Swiplet 扩展示例
// 安装到设备后可通过 swipt swiplet call <id> <action> 调用

import { defineExtension, defineAction } from "swipt";

export default defineExtension({
  actions: {
    hello: defineAction({
      title: "Hello",
      description: "返回设备信息",
      run: async () => {
        const info = await device.info();
        return { name: info.name, os: info.os, screen: info.screen };
      },
    }),

    screenshot: defineAction({
      title: "Screenshot",
      description: "截图并保存到数据目录",
      run: async () => {
        const image = await device.screenshot();
        const file = dataDirectory.file("swiplet-screenshot.png");
        await image.copy(file);
        return { saved: file.uri };
      },
    }),
  },
});
