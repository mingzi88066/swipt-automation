#!/usr/bin/env python3
import sys, struct, urllib.request

DEVICE = sys.argv[1] if len(sys.argv) > 1 else "http://iPhone.local:29937"
URL = f"{DEVICE}/swipt.SwipletService/CallAction"

# CallActionRequest: swiplet_id="auto-call-recorder", action="triggerOnce"
swiplet_id = b"auto-call-recorder"
action = b"triggerOnce"
msg = bytes([0x0a, len(swiplet_id)]) + swiplet_id
msg += bytes([0x12, len(action)]) + action
frame = struct.pack(">BI", 0, len(msg)) + msg

req = urllib.request.Request(
    URL,
    data=frame,
    headers={
        "Content-Type": "application/grpc-web+proto",
        "X-Grpc-Web": "1",
        "Accept": "application/grpc-web-text+proto,application/grpc-web+proto",
    },
    method="POST",
)

try:
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = resp.read()
        print(f"HTTP Status: {resp.status}")
        print(f"Response length: {len(data)} bytes")
        pos = 0
        import re
        while pos < len(data):
            if pos + 5 > len(data):
                break
            flag = data[pos]
            length = struct.unpack(">I", data[pos+1:pos+5])[0]
            pos += 5
            if pos + length > len(data):
                break
            body = data[pos:pos+length]
            pos += length
            if flag == 0:
                text = body.decode("utf-8", "replace")
                strings = re.findall(r'[\x20-\x7e\u4e00-\u9fff]{2,}', text)
                for s in strings:
                    print("  >", s)
            elif flag == 1:
                print("Trailer:", body.decode("utf-8", "replace"))
except urllib.error.HTTPError as e:
    print(f"HTTP Error: {e.code}")
    print(e.read().decode("utf-8", "replace"))
except Exception as e:
    print(f"Error: {e}")
