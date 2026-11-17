// 示例：从 Swipt 内部发起 HTTP 请求
const client = new http.Client();

const response = await client.fetch("https://api.github.com/repos/swipt-automation/swipt", {
  headers: {
    "User-Agent": "Swipt-Automation",
  },
});

const body = await response.text();
console.log("Status:", response.status);
console.log("Body preview:", body.slice(0, 500));

// 保存到数据目录
const file = dataDirectory.file("github-response.json");
await file.write(body);
console.log("响应已保存:", file.uri);
