#!/bin/sh
# 通话界面调试脚本（shell 版，无需 Python）
# 用法: sh inspect_call.sh [DEVICE_URL]

DEVICE="${1:-http://iPhone.local:29937}"
URL="$DEVICE/swipt.SwipletService/CallAction"

# CallActionRequest { swiplet_id="auto-call-recorder", action="inspect" }
# 0a 14 auto-call-recorder, 12 07 inspect
printf '\x00\x00\x00\x00\x1d\x0a\x14auto-call-recorder\x12\x07inspect' > /tmp/swipt_inspect.bin

echo "正在调用 inspect: $URL"
curl -s -X POST "$URL" \
  -H "Content-Type: application/grpc-web+proto" \
  -H "X-Grpc-Web: 1" \
  --data-binary @/tmp/swipt_inspect.bin \
  -o /tmp/swipt_inspect_resp.bin \
  -w "HTTP Status: %{http_code}\n"

echo "响应内容（十六进制/文本）:"
hexdump -C /tmp/swipt_inspect_resp.bin 2>/dev/null || od -A x -t x1z /tmp/swipt_inspect_resp.bin 2>/dev/null
