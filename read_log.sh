#!/bin/sh
# 读取 auto-call-recorder 的调试日志
# 用法: sh read_log.sh [DEVICE_URL]

DEVICE="${1:-http://iPhone.local:29937}"
URL="$DEVICE/swipt.SwipletService/CallAction"

# CallActionRequest { swiplet_id="auto-call-recorder", action="readLog" }
printf '\x00\x00\x00\x00\x1f\x0a\x14auto-call-recorder\x12\x07readLog' > /tmp/swipt_readlog.bin

echo "正在读取调试日志: $URL"
curl -s -X POST "$URL" \
  -H "Content-Type: application/grpc-web+proto" \
  -H "X-Grpc-Web: 1" \
  --data-binary @/tmp/swipt_readlog.bin \
  -o /tmp/swipt_readlog_resp.bin \
  -w "HTTP Status: %{http_code}\n"

echo ""
echo "=== 日志内容 ==="
# 尝试用 Python 解析
if command -v python3 >/dev/null 2>&1; then
  python3 -c "
import sys
data = open('/tmp/swipt_readlog_resp.bin','rb').read()
import re
text = data.decode('utf-8','replace')
strings = re.findall(r'[\x20-\x7e\u4e00-\u9fff\u3000-\u303f\n]+', text)
print(''.join(strings))
"
else
  cat /tmp/swipt_readlog_resp.bin 2>/dev/null | strings
fi
