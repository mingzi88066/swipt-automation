// 获取设备基本信息
const info = await device.info();
console.log(JSON.stringify(info, null, 2));

// 示例输出：
// {
//   "name": "iPhone",
//   "model": "iPhone16,2",
//   "os": "iOS 27.0",
//   "build": "...",
//   "language": "zh-Hans-CN",
//   "screen": {
//     "width": 393,
//     "height": 852,
//     "scale": 3,
//     "orientation": "portrait"
//   }
// }
