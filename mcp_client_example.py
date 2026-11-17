#!/usr/bin/env python3
"""
Swipt MCP over HTTP 示例客户端
用法：python3 mcp_client_example.py http://iPhone.local:29937/mcp
"""

import sys
import json
import uuid
import urllib.request
import urllib.error


def call_tool(base_url: str, tool_name: str, arguments: dict):
    """调用 Swipt MCP 工具（简化版，未包含完整协议握手）。"""
    payload = {
        "jsonrpc": "2.0",
        "id": str(uuid.uuid4()),
        "method": "tools/call",
        "params": {"name": tool_name, "arguments": arguments},
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        base_url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


if __name__ == "__main__":
    url = sys.argv[1] if len(sys.argv) > 1 else "http://iPhone.local:29937/mcp"
    print(f"连接: {url}")

    # 示例：运行一段 JS 代码获取设备信息
    code = "await device.info()"
    try:
        result = call_tool(url, "repl_run", {"code": code})
        print(json.dumps(result, indent=2, ensure_ascii=False))
    except urllib.error.URLError as e:
        print(f"连接失败: {e}")
        print("注意：此脚本需要从能访问 iPhone.local 的网络运行。")
