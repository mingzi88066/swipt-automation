#!/bin/sh
# 列出所有 Swiplet 及其服务状态
# 用法: sh list_swiplets.sh [DEVICE_URL]

DEVICE="${1:-http://iPhone.local:29937}"
URL="$DEVICE/swipt.SwipletService/ListSwiplets"

# gRPC-Web 请求体：空消息（Empty）
printf '\x00\x00\x00\x00\x00' > /tmp/swipt_list_req.bin

echo "正在查询 Swiplet 列表: $URL"
curl -s -X POST "$URL" \
  -H "Content-Type: application/grpc-web+proto" \
  -H "X-Grpc-Web: 1" \
  --data-binary @/tmp/swipt_list_req.bin \
  -o /tmp/swipt_list_resp.bin \
  -w "HTTP Status: %{http_code}\n"

echo ""
echo "响应内容（hexdump）:"
od -A x -t x1z /tmp/swipt_list_resp.bin 2>/dev/null || cat /tmp/swipt_list_resp.bin
echo ""

# 尝试提取可读文本
echo "可读文本:"
strings /tmp/swipt_list_resp.bin 2>/dev/null || cat /tmp/swipt_list_resp.bin | tr -cd '\40-\176\n'
echo ""
