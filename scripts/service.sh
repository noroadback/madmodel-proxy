#!/bin/sh
# scripts/service.sh — madproxy 生命周期管理(幂等 start/stop/status/restart)。
#
# 风格对齐调用方仓库的 code-server.sh:pid 文件 + 端口兜底 + 健康探测。
# 本脚本随 madmodel-proxy 仓库走(THU-CVML fork),外部仓库的 Makefile 只做
# 一句话转接,不重复任何逻辑。
#
# 默认形态(88 部署):对外监听 0.0.0.0 + API Key 鉴权 + 校园网直连上游。
# 全部可用环境变量覆盖:
#   MADPROXY_PORT      监听端口,默认 18987
#   MADPROXY_BIND      监听地址,默认 0.0.0.0(仅本机设 127.0.0.1)
#   MADPROXY_API_KEYS  API Key(逗号分隔)。默认取 ~/.madmodel-proxy/api-keys 文件;
#                      对外监听(非回环)且无 key 时脚本拒绝启动(裸奔防呆)
#   MADPROXY_UPSTREAM  上游端点,默认校园网直连 madmodel.cs;设 "tunnel" 走 WebVPN
#   MADPROXY_NODE      node 可执行,默认自动探测(PATH → 常见绝对路径)
#   MADPROXY_DIR       madproxy 源码目录,默认脚本所在仓库根
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROXY_DIR="${MADPROXY_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"

PORT="${MADPROXY_PORT:-18987}"
BIND="${MADPROXY_BIND:-0.0.0.0}"
CAMPUS_UPSTREAM="https://madmodel.cs.tsinghua.edu.cn/v1/chat/completions"
UPSTREAM_RAW="${MADPROXY_UPSTREAM:-$CAMPUS_UPSTREAM}"

LOG_DIR="$SCRIPT_DIR/.logs"
PID_FILE="$LOG_DIR/madproxy.pid"
LOG_FILE="$LOG_DIR/madproxy.log"
KEYFILE="$HOME/.madmodel-proxy/api-keys"

# node 探测:PATH 优先,回退项目自带的 node24 与常见绝对路径。
# (节点上有 seccomp guard,`timeout node` 会 EPERM,故不经 timeout 包裹)
find_node() {
    if [ -n "${MADPROXY_NODE:-}" ]; then echo "$MADPROXY_NODE"; return; fi
    if command -v node >/dev/null 2>&1; then command -v node; return; fi
    for c in /private/ycm/dsh-combo/.tools/node-v24.21.0-linux-x64/bin/node \
             /usr/local/bin/node /usr/bin/node; do
        [ -x "$c" ] && { echo "$c"; return; }
    done
    echo "node"  # 交给调用处报错
}
NODE="$(find_node)"

# API Key 解析:环境变量优先,否则读 keyfile(每行一个,# 注释,逗号拼接)
resolve_keys() {
    if [ -n "${MADPROXY_API_KEYS:-}" ]; then printf '%s' "$MADPROXY_API_KEYS"; return; fi
    [ -f "$KEYFILE" ] || { printf ''; return; }
    grep -vE '^\s*(#|$)' "$KEYFILE" 2>/dev/null | paste -sd, - 2>/dev/null || printf ''
}

# 上游归一:tunnel/空 → 不设(走 madproxy 默认 WebVPN);其余原样(含 campus 直连)
resolve_upstream() {
    case "$UPSTREAM_RAW" in
        tunnel|TUNNEL|webvpn|WEBVPN) printf '' ;;
        *) printf '%s' "$UPSTREAM_RAW" ;;
    esac
}

alive() {
    curl -s --max-time 3 "http://127.0.0.1:$PORT/healthz" 2>/dev/null | grep -q '^ok$'
}

lan_ip() {
    ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1
}

start() {
    if alive; then
        echo "madproxy: already running at http://127.0.0.1:$PORT (/healthz ok)"
        return 0
    fi
    KEYS="$(resolve_keys)"
    UPSTREAM="$(resolve_upstream)"
    # 对外监听裸奔防呆:非回环 + 无 key = 拒绝启动
    if [ "$BIND" != "127.0.0.1" ] && [ "$BIND" != "localhost" ] && [ -z "$KEYS" ]; then
        echo "madproxy: 拒绝启动 —— 对外监听 $BIND 但未配置 API Key。" >&2
        echo "  设 MADPROXY_API_KEYS=<k1,k2>,或写入 $KEYFILE(每行一个),或改 MADPROXY_BIND=127.0.0.1" >&2
        return 1
    fi
    [ -x "$NODE" ] || command -v "$NODE" >/dev/null 2>&1 || { echo "madproxy: 找不到 node($NODE)" >&2; return 1; }
    [ -f "$PROXY_DIR/dashboard.js" ] || { echo "madproxy: $PROXY_DIR 下没有 dashboard.js" >&2; return 1; }
    mkdir -p "$LOG_DIR"
    # dashboard.js 同窗拉起 watch 续期 + proxy;env 注入监听/鉴权/上游。
    # 用 export 而非命令前缀:${VAR:+NAME=val} 展开出的赋值在 dash 里会被当
    # 命令名执行(而非赋值),故显式 export,PROXY_UPSTREAM 仅在非空时设。
    ( cd "$PROXY_DIR"; \
      export PROXY_PORT="$PORT" PROXY_BIND_HOST="$BIND" PROXY_API_KEYS="$KEYS"; \
      [ -n "$UPSTREAM" ] && export PROXY_UPSTREAM="$UPSTREAM"; \
      nohup "$NODE" dashboard.js >"$LOG_FILE" 2>&1 & echo $! > "$PID_FILE" )
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
        alive && {
            echo "madproxy: started on $BIND:$PORT (log: $LOG_FILE)"
            [ -n "$KEYS" ] && echo "madproxy: API Key 鉴权已启用($(printf '%s' "$KEYS" | tr ',' '\n' | grep -c .) 个)" \
                           || echo "madproxy: 无鉴权(仅本机回环 + Host 白名单)"
            echo "madproxy: 上游 = ${UPSTREAM:-WebVPN 隧道(默认)}"
            [ "$BIND" = "127.0.0.1" ] || echo "madproxy: LAN -> http://$(lan_ip):$PORT/v1"
            return 0
        }
        sleep 1
    done
    echo "madproxy: FAILED to start, see $LOG_FILE" >&2
    tail -15 "$LOG_FILE" >&2 || true
    return 1
}

stop() {
    stopped=0
    if [ -f "$PID_FILE" ]; then
        pid="$(cat "$PID_FILE" 2>/dev/null || true)"
        # dashboard 是 watch/proxy 的父进程,杀进程组更干净;失败退回单 kill
        if [ -n "$pid" ] && kill -- "-$pid" 2>/dev/null; then
            echo "madproxy: stopped process group (pid $pid)"; stopped=1
        elif [ -n "$pid" ] && kill "$pid" 2>/dev/null; then
            echo "madproxy: stopped (pid $pid)"; stopped=1
        fi
        rm -f "$PID_FILE"
    fi
    # pid 文件丢失/过期兜底:按端口清残留(否则占端口)
    orphans="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$orphans" ]; then
        echo "$orphans" | while read -r opid; do
            [ -n "$opid" ] || continue
            kill "$opid" 2>/dev/null && echo "madproxy: stopped orphan on port $PORT (pid $opid)"
        done
        stopped=1
    fi
    # dashboard 的子进程(watch/proxy)可能跨会话残留,按命令特征兜底清理
    leftover="$(pgrep -f "$PROXY_DIR/(dashboard|proxy|refresh-token)" 2>/dev/null || true)"
    if [ -n "$leftover" ]; then
        echo "$leftover" | xargs kill 2>/dev/null && echo "madproxy: cleaned leftover watch/proxy" || true
        stopped=1
    fi
    [ "$stopped" -eq 1 ] || echo "madproxy: not running"
}

status() {
    if alive; then
        echo "madproxy: UP at http://127.0.0.1:$PORT (/healthz ok)"
        [ "$BIND" = "127.0.0.1" ] || echo "madproxy: LAN -> http://$(lan_ip):$PORT/v1"
        pid="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
        [ -n "$pid" ] && echo "madproxy: listener pid $pid"
    else
        echo "madproxy: DOWN"
        return 1
    fi
}

case "${1:-status}" in
    start)   start ;;
    stop)    stop ;;
    restart) stop; for _ in 1 2 3 4 5; do alive || break; sleep 1; done; start ;;
    status)  status ;;
    *) echo "usage: $0 start|stop|restart|status" >&2; exit 2 ;;
esac
