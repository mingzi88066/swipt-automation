#!/bin/sh
# 手动触发一次录音点击（shell 版）
# 用法: sh trigger_once.sh [DEVICE_URL]

DEVICE="${1:-http://iPhone.local:29937}"
URL="$DEVICE/swipt.SwipletService/CallAction"

# CallActionRequest { swiplet_id="auto-call-recorder", action="triggerOnce" }
printf '\x00\x00\x00\x00\x20\x0a\x14auto-call-recorder\x12\x0ctriggerOnce' > /tmp/swipt_trigger.bin

echo "正在调用 triggerOnce: $URL"
curl -s -X POST "$URL" \
  -H "Content-Type: application/grpc-web+proto" \
  -H "X-Grpc-Web: 1" \
  --data-binary @/tmp/swipt_trigger.bin \
  -o /tmp/swipt_trigger_resp.bin \
  -w "HTTP Status: %{http_code}\n"

echo "响应内容（十六进制/文本）:"
hexdump -C /tmp/swipt_trigger_resp.bin 2>/dev/null || od -A x -t x1z /tmp/swipt_trigger_resp.bin 2>/dev/null
