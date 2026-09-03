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
    # do javascript 阻塞到脚本结束(脚本正常 app.quit)或 Illustrator 卡死。
    # 将其放入后台,主循环监控日志进度;若卡死则强制结束 AI 并跳过。
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
        # 强制结束 Illustrator 与 osascript(卡死,无法正常退出)
        kill "$osascript_pid" 2>/dev/null
        pkill -x osascript 2>/dev/null
        pkill -x "Adobe Illustrator" 2>/dev/null
        sleep 3
        echo "已强制结束 Illustrator,下一轮跳过卡死文件..."
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
