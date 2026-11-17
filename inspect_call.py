#!/usr/bin/env python3
import sys, struct, json, urllib.request

DEVICE = sys.argv[1] if len(sys.argv) > 1 else "http://iPhone.local:29937"
URL = f"{DEVICE}/swipt.SwipletService/CallAction"

# Build CallActionRequest protobuf
# field 1: swiplet_id = "auto-call-recorder"
# field 2: action = "inspect"
swiplet_id = b"auto-call-recorder"
action = b"inspect"
msg = bytes([0x0a, len(swiplet_id)]) + swiplet_id
msg += bytes([0x12, len(action)]) + action

# gRPC-Web frame: flag(1) + length(4) + message
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
        if not data:
            print("No response data")
            sys.exit(0)

        # Parse gRPC-Web response frames
        pos = 0
        while pos < len(data):
            if pos + 5 > len(data):
                print("Incomplete frame header")
                break
            flag = data[pos]
            length = struct.unpack(">I", data[pos+1:pos+5])[0]
            pos += 5
            if pos + length > len(data):
                print("Incomplete frame body")
                break
            body = data[pos:pos+length]
            pos += length

            if flag == 0:
                # Data frame - try to decode as CallActionResponse
                # The response contains LogEntry or Value
                # Just print ASCII strings from the protobuf for now
                text = body.decode("utf-8", "replace")
                # Filter to printable/log-looking content
                import re
                strings = re.findall(r'[\x20-\x7e\u4e00-\u9fff]{2,}', text)
                for s in strings:
                    print("  >", s)
            elif flag == 1:
                # Trailer
                print("Trailer:", body.decode("utf-8", "replace"))
            else:
                print(f"Unknown flag {flag}, hex: {body.hex()}")
except urllib.error.HTTPError as e:
    print(f"HTTP Error: {e.code}")
    print(e.read().decode("utf-8", "replace"))
except Exception as e:
    print(f"Error: {e}")
