#!/bin/sh
# install-on-phone.sh
# 在 iPhone 上的 Linux 虚拟机（LinuxRunner / Debian ARM64）里一键安装并启用 auto-call-recorder
# 用法（在手机虚拟机的终端里执行）:
#   curl -fsSL -o install-on-phone.sh https://raw.githubusercontent.com/mingzi88066/swipt-automation/main/install-on-phone.sh
#   sh install-on-phone.sh
#
# 如果 10.7.0.1 连不上，用手机局域网 IP 重试（iOS 设置 → 无线局域网 → 当前网络详情里有 IP）:
#   DEVICE_URL=http://192.168.x.x:29937 sh install-on-phone.sh
#
# 前提: 手机上 Loopback VPN（LocalDevVPN 等）已开启，Swipt App 已安装并完成设置

set -e

NODE_VERSION=v22.13.0
NODE_DIR="$HOME/node22"
DEVICE_URL="${DEVICE_URL:-http://10.7.0.1:29937}"
PKG_URL="https://raw.githubusercontent.com/mingzi88066/swipt-automation/main/releases/auto-call-recorder.swiplet"

step() { echo; echo "==> $1"; }

# ---------- 0. 检查网络 ----------
step "检查网络（需要访问 nodejs.org 和 GitHub）"
if ! curl -sS -m 15 https://nodejs.org/dist/ >/dev/null 2>&1; then
  echo "无法访问 nodejs.org，请检查虚拟机网络"
  exit 1
fi
echo "网络 OK"

# ---------- 1. 安装 Node 22（CLI 在 Node 20 上会报 Iterator is not defined 崩溃）----------
if [ ! -x "$NODE_DIR/bin/node" ]; then
  step "下载并安装 Node $NODE_VERSION 到 ~/node22（约 25MB，稍等）"
  ARCH=$(uname -m)
  case "$ARCH" in
    aarch64|arm64) ARCH=arm64 ;;
    x86_64) ARCH=x64 ;;
    *) echo "不支持的架构: $ARCH"; exit 1 ;;
  esac
  mkdir -p "$NODE_DIR"
  curl -fsSL -m 600 -o /tmp/node.tar.xz \
    "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-$ARCH.tar.xz"
  tar -xJf /tmp/node.tar.xz -C "$NODE_DIR" --strip-components=1
  rm -f /tmp/node.tar.xz
else
  step "Node 22 已存在，跳过下载"
fi
export PATH="$NODE_DIR/bin:$PATH"
# 写入 profile，以后开新终端也能用
if ! grep -q "node22/bin" "$HOME/.profile" 2>/dev/null; then
  echo "export PATH=\"$NODE_DIR/bin:\$PATH\"" >> "$HOME/.profile"
fi
echo "Node 版本: $(node -v)"

# ---------- 2. 安装 Swipt CLI ----------
step "安装 Swipt CLI（npm 全局安装，稍等）"
# 清掉旧的坏安装（Node 20 装的 /usr/local 版本），避免 PATH 命中旧命令
rm -f /usr/local/bin/swipt 2>/dev/null || true
if ! command -v swipt >/dev/null 2>&1; then
  npm install -g @swipt/cli --no-fund --no-audit
fi
echo "Swipt CLI: $(swipt version 2>/dev/null || echo 已安装)"

# ---------- 3. 连接本机设备 ----------
step "连接 iPhone 上的 Swipt（$DEVICE_URL）"
if ! curl -sS -m 5 "$DEVICE_URL" >/dev/null 2>&1; then
  echo "✗ 连不上 $DEVICE_URL"
  echo "  请检查:"
  echo "  1) 手机上 Loopback VPN（LocalDevVPN）是否已开启"
  echo "  2) Swipt App 是否已安装并完成初始设置"
  echo "  3) 若仍不行，用手机局域网 IP 重试:"
  echo "     DEVICE_URL=http://<手机IP>:29937 sh $0"
  exit 1
fi
swipt device add "$DEVICE_URL" 2>/dev/null || echo "(设备可能已添加过，继续)"
swipt device list

# ---------- 4. 下载并安装 Swiplet ----------
step "下载 auto-call-recorder 安装包"
curl -fsSL -m 120 -o /tmp/auto-call-recorder.swiplet "$PKG_URL"

step "安装到设备（会替换旧版本）"
swipt swiplet install /tmp/auto-call-recorder.swiplet -d "$DEVICE_URL" ||
  swipt swiplet install /tmp/auto-call-recorder.swiplet

# ---------- 5. 启用服务 ----------
step "启用自动录音服务"
swipt swiplet service enable auto-call-recorder -d "$DEVICE_URL" ||
  swipt swiplet service enable auto-call-recorder

step "完成 ✅ 当前 Swiplet 列表:"
swipt swiplet list -d "$DEVICE_URL" 2>/dev/null || swipt swiplet list

echo
echo "下一步: 打开手机上的 Swipt App → 自动通话录音，界面里也有开关和状态。"
echo "以后在虚拟机里看实时日志: swipt device logs --follow --swiplet auto-call-recorder"
echo "（注意: 新开终端需先 source ~/.profile 让 node22/swipt 生效）"
