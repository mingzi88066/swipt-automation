#!/bin/sh
# 启用 auto-call-recorder Swiplet 服务
# 用法: sh enable_service.sh [DEVICE_URL]
# 默认: http://iPhone.local:29937

DEVICE="${1:-http://iPhone.local:29937}"
URL="$DEVICE/swipt.SwipletService/SetServiceEnabled"

# gRPC-Web 二进制请求体
# SetServiceEnabledRequest { swiplet_id="auto-call-recorder", enabled=true }
printf '\x00\x00\x00\x00\x16\x0a\x14auto-call-recorder\x10\x01' > /tmp/swipt_req.bin

echo "正在启用服务: $URL"
curl -s -X POST "$URL" \
  -H "Content-Type: application/grpc-web+proto" \
  -H "X-Grpc-Web: 1" \
  --data-binary @/tmp/swipt_req.bin \
  -o /tmp/swipt_resp.bin \
  -w "HTTP Status: %{http_code}\n"

echo "响应内容:"
od -A x -t x1z /tmp/swipt_resp.bin 2>/dev/null || cat /tmp/swipt_resp.bin
echo ""
echo "完成。如果 HTTP Status 是 200，服务应该已启用。"
