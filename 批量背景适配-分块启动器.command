#!/bin/bash
# 批量背景适配 - 分块启动器(macOS)
# ---------------------------------------------------------------------------
# 原理:
#   批量背景适配.jsx 每处理 maxFilesPerSession 个文件就会写 批次游标.txt
#   并退出 Illustrator(释放不断累积的原生内存),否则 Illustrator 会在
#   约数百个文件后因内存泄漏卡死。
#   本脚本循环:读 批次游标.txt -> 运行 JSX(自动启动 Illustrator) ->
#   等 Illustrator 退出 -> 标记为 CONTINUE 则再来一轮,DONE 则结束。
#
# 自动卡死恢复:
#   某些 .ai 文件会触发 Illustrator 原生处理死循环(如 gesture.ai、
#   google wallet alt.ai),表现为单文件 CPU 100%、日志停滞、脚本永久等待。
#   本脚本每轮运行后监控最新日志;若在 STALL_SECONDS(默认 240)内无新内容
#   且 Illustrator 仍在运行,判定卡死 → 从日志定位当前文件 → 写入
#   跳过列表.txt → 强制结束 Illustrator → 下一轮自动跳过该文件继续。
#
# 使用:
#   1. 关闭正在运行的 Illustrator(否则 JSX 会在你的会话里执行并退出应用)。
#   2. 双击本文件(或终端运行)。它会处理/续跑整个 文件列表.txt。
#   3. 中断安全:任意时候按 Ctrl+C 或崩溃,重跑本脚本即从上次进度续跑
#      (依据 背景适配完成记录.txt,已完成的文件不会重做)。
#
# 注意:本脚本依赖 AppleScript 控制 Illustrator;首次运行如遇系统询问
#       自动化权限,请允许"终端"或"bash"控制 Adobe Illustrator。
# ---------------------------------------------------------------------------
set -u

APP_ID="com.adobe.illustrator"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
JSX="$SCRIPT_DIR/批量背景适配.jsx"
MARKER="$SCRIPT_DIR/batch-restart.txt"
LOG_DIR="$SCRIPT_DIR/背景适配"
SKIP_FILE="$SCRIPT_DIR/跳过列表.txt"
LIST_FILE="$SCRIPT_DIR/文件列表.txt"

# 安全上限:防止意外情况下无限重启(4521 文件 / 200 上限 ≈ 23 轮)
MAX_ROUNDS=100
# 卡死判定:日志停滞超过此秒数且 Illustrator 仍运行 → 判定卡死
# 240s 对 Graph 层慢文件(saveAs 需 1-3 分钟)太紧,易误判;取 600s。
STALL_SECONDS=600
# 检查间隔
CHECK_INTERVAL=20

echo "=== 批量背景适配 分块启动器 ==="
echo "脚本: $JSX"
echo "标记: $MARKER"
echo "跳过列表: $SKIP_FILE"
echo ""

# 重启前重建 文件列表.txt:原始列表 - 跳过列表
# 注意:当前 文件列表.txt 是主列表;跳过列表独立存在,驱动每次启动前重建
# 主列表以排除已跳过的文件。为保留原始列表,先保存一份 backup。
ORIG_LIST="$SCRIPT_DIR/文件列表-原始.txt"
if [ ! -f "$ORIG_LIST" ]; then
    cp "$LIST_FILE" "$ORIG_LIST" 2>/dev/null
    echo "已保存原始列表 → $ORIG_LIST"
fi

rebuild_list() {
    # 用原始列表重建主列表,剔除 跳过列表.txt 中的路径
    if [ -f "$SKIP_FILE" ] && [ -f "$ORIG_LIST" ]; then
        grep -vxF -f "$SKIP_FILE" "$ORIG_LIST" > "$LIST_FILE" 2>/dev/null
        echo "[rebuild] 已排除 $(wc -l < "$SKIP_FILE" | tr -d ' ') 个跳过文件,当前列表 $(wc -l < "$LIST_FILE" | tr -d ' ') 行"
    fi
}

# 确保 Illustrator 在运行并接受 AppleScript(最长等待 180s)
# 使用二进制直接启动,随后轮询 do javascript 直到就绪;
# 若 AppleScript 因 LaunchServices 状态损坏(-600/-2740)无法连接,
# 尝试 lsregister 重新注册后重试。
AI_BIN="/Applications/Adobe Illustrator 2025/Adobe Illustrator.app/Contents/MacOS/Adobe Illustrator"
LS_REGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

ai_ready() {
    # 检测 AI 是否可执行 do javascript(就绪判定)。
    # 注意:macOS 系统 shell 无 GNU timeout,直接用 osascript;
    # AI 已就绪时 osascript 秒回,未就绪时 do javascript 会隐式
    # 启动 AI(可能需 15-60s)——由外层轮询循环控制总时长。
    local osa_out
    osa_out=$(osascript -e "tell application id \"$APP_ID\" to do javascript \"app.name\"" 2>&1)
    if echo "$osa_out" | grep -q "Illustrator"; then
        return 0
    fi
    # do javascript 失败(可能 AI 忙,正在执行 JSX)。
    # 判断:AI 进程存在 且 最新日志在近期更新 → 已有 JSX 在跑,视为可用。
    local logfile last_mtime age
    if ai_ping; then
        logfile=$(latest_log 2>/dev/null)
        if [ -n "$logfile" ]; then
            last_mtime=$(stat -f %m "$logfile" 2>/dev/null || echo 0)
            age=$(( $(date +%s) - last_mtime ))
            if [ "$age" -lt 120 ]; then
                return 0  # 日志 2 分钟内更新过 → JSX 正在处理
            fi
        fi
    fi
    return 1
}

ai_ping() {
    # 轻量检测:AI 进程是否存在
    pgrep -f "Contents/MacOS/Adobe Illustrator" >/dev/null 2>&1
}

ensure_ai_ready() {
    local i
    # 关键:osascript do javascript 会隐式启动 Illustrator(即使
    # LaunchServices 状态异常)-600,无需 open/二进制启动。
    # 只需轮询 do javascript 直到成功(AI 启动需 20s-3min)。
    # 分 3 轮每轮 100s(总计 300s),每 10s 检测一次。
    echo "  [ai] 就绪检测(轮询 do javascript,AI 未运行会隐式启动)..."
    for i in $(seq 1 10); do
        sleep 10
        if ai_ready; then
            echo "  [ai] Illustrator 就绪(第 $i 次检查)"
            return 0
        fi
    done
    # 第二轮(隐式启动可能较慢)
    echo "  [ai] 继续等待+尝试 lsregister 修复..."
    "$LS_REGISTER" -f "/Applications/Adobe Illustrator 2025/Adobe Illustrator.app" >/dev/null 2>&1
    sleep 5
    for i in $(seq 1 10); do
        sleep 10
        if ai_ready; then
            echo "  [ai] 修复后 Illustrator 就绪(第 $i 次检查)"
            return 0
        fi
    done
    # 第三轮
    for i in $(seq 1 10); do
        sleep 10
        if ai_ready; then
            echo "  [ai] Illustrator 最终就绪(第 $i 次检查)"
            return 0
        fi
    done
    # 300s 仍未就绪:若 AI 进程存在,可能是卡死残留(上一次处理卡死
    # 导致 AI 无法响应 AppleScript)。优雅退出后重启轮询。
    if ai_ping; then
        echo "  [ai] AI 存在但未就绪(疑似卡死残留),优雅退出后重试..."
        stop_ai_gracefully
        sleep 5
        for i in $(seq 1 10); do
            sleep 10
            if ai_ready; then
                echo "  [ai] 清理残留后 Illustrator 就绪(第 $i 次检查)"
                return 0
            fi
        done
    fi
    echo "  [ai] !! Illustrator 始终未就绪(超时)" >&2
    return 1
}

stop_ai_gracefully() {
    # 卡死退出:先尝试 AppleScript quit 优雅退出,保留 LaunchServices 状态
    osascript -e "tell application id \"$APP_ID\" to quit" >/dev/null 2>&1
    # 等 15s 看是否退出
    for _ in $(seq 1 15); do
        sleep 1
        if ! ai_ping; then
            echo "  [ai] 已优雅退出"
            return 0
        fi
    done
    # 优雅退出失败,才强制结束
    pkill -x "Adobe Illustrator" 2>/dev/null
    sleep 3
    if ! ai_ping; then
        echo "  [ai] 已强制结束(graceful quit 超时)"
        return 0
    fi
    echo "  [ai] !! Illustrator 未能退出" >&2
    return 1
}

# 定位最新日志(排除完成记录)
latest_log() {
    ls -t "$LOG_DIR"/*日志*.txt 2>/dev/null | head -1
}

get_current_file() {
    # 从最新日志中定位当前处理的文件(最后一个 [N/M] 条目)
    local logfile
    logfile=$(latest_log)
    [ -n "$logfile" ] || return
    # 找最后一个 [N/M] 后紧跟的源文件路径
    tail -50 "$logfile" | grep -oE 'source=[^ ]+' | tail -1 | sed 's/^source=//'
}

ROUND=0
while true; do
    ROUND=$((ROUND + 1))
    if [ "$ROUND" -gt "$MAX_ROUNDS" ]; then
        echo "!! 超过 $MAX_ROUNDS 轮仍未完成,请检查 背景适配日志" >&2
        exit 1
    fi

    # tr -d '\r' defends against a trailing CR: older script versions wrote
    # the marker with a platform line ending (0x0d), which breaks exact
    # string comparison in bash 3.2 (no built-in \r stripping in $()).
    MARKER_STATE="$(tr -d '\r' < "$MARKER" 2>/dev/null || true)"
    if [ "$MARKER_STATE" = "DONE" ]; then
        echo "=== 批次已完成(标记: DONE)==="
        exit 0
    fi

    if [ "$MARKER_STATE" != "CONTINUE" ] && [ "$ROUND" -gt 1 ]; then
        echo "!! 第 $ROUND 轮:标记为 '$MARKER_STATE'(非 CONTINUE/DONE),停止以防死循环" >&2
        exit 1
    fi

    rebuild_list

    echo "--- 第 $ROUND 轮:运行脚本(启动/复用 Illustrator)---"
    # 确保 AI 运行并就绪后再发 JSX(避免 osascript -600 挂起)
    if ! ensure_ai_ready; then
        echo "!! 第 $ROUND 轮:Illustrator 未就绪,停止(请手动打开后重跑)" >&2
        exit 1
    fi
    # do javascript 阻塞到脚本结束(脚本正常 app.quit)或 Illustrator 卡死。
    # 将其放入后台,主循环监控日志进度;若卡死则优雅退出 AI 并跳过。
    osascript <<OSA 2>/dev/null &
tell application id "$APP_ID"
    do javascript (POSIX file "$JSX" as alias)
end tell
OSA
    osascript_pid=$!

    # 监控:若日志 STALL_SECONDS 无增长且 Illustrator 在运行 → 判定卡死
    waited=0
    last_size=0
    stall_detected=0
    for _ in $(seq 1 $((STALL_SECONDS / CHECK_INTERVAL))); do
        RUNNING="$(osascript -e 'tell application id "'$APP_ID'" to running' 2>/dev/null || echo false)"
        if [ "$RUNNING" != "true" ]; then
            break  # Illustrator 已退出(正常完成或崩溃)
        fi
        current_size=0
        logfile=$(latest_log)
        [ -n "$logfile" ] && current_size=$(stat -f %z "$logfile" 2>/dev/null)
        if [ ! -z "$logfile" ] && [ "$current_size" = "$last_size" ] && [ "$last_size" -gt 0 ]; then
            waited=$((waited + CHECK_INTERVAL))
            if [ "$waited" -ge "$STALL_SECONDS" ]; then
                stall_detected=1
                break
            fi
        else
            waited=0
            last_size="$current_size"
        fi
        sleep "$CHECK_INTERVAL"
    done

    if [ "$stall_detected" = "1" ]; then
        stuck_file="$(get_current_file)"
        if [ -n "$stuck_file" ]; then
            echo "!! 检测到卡死: $stuck_file (日志停滞 ${STALL_SECONDS}s)"
            if [ -f "$SKIP_FILE" ]; then
                grep -qxF "$stuck_file" "$SKIP_FILE" || echo "$stuck_file" >> "$SKIP_FILE"
            else
                echo "$stuck_file" > "$SKIP_FILE"
            fi
            echo "  已加入跳过列表 $SKIP_FILE"
        fi
        # 优雅退出 Illustrator(保留 LaunchServices 状态,避免下次启动失败)
        kill "$osascript_pid" 2>/dev/null
        pkill -x osascript 2>/dev/null
        stop_ai_gracefully
        echo "已结束 Illustrator,下一轮跳过卡死文件..."
        continue
    else
        wait "$osascript_pid" 2>/dev/null
    fi

    sleep 2

    # 会话结束:等退出后读标记,决定下一轮
    MARKER_STATE="$(tr -d '\r' < "$MARKER" 2>/dev/null || true)"
    if [ "$MARKER_STATE" = "DONE" ]; then
        echo "=== 第 $ROUND 轮完成,批次全部处理完毕 ==="
        exit 0
    fi
    if [ "$MARKER_STATE" != "CONTINUE" ]; then
        echo "!! 第 $ROUND 轮后标记为 '$MARKER_STATE'(缺失或异常),停止" >&2
        exit 1
    fi
    echo "第 $ROUND 轮结束:CONTINUE,准备重启 Illustrator 续跑..."
    echo ""
done
