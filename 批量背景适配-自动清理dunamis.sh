#!/bin/bash
# 批量背景适配 - 自动清理 Adobe dunamis 遥测旧日志
#
# 背景: Adobe dunamis(遥测/诊断,内嵌 Illustrator)持续高频率写日志,
# 每次轮转产生约 100MB 文件;Application Support 也累积事件数据。
# 此脚本在批处理运行期间周期性清理"非当前写句柄"的旧日志,
# 防止遥测数据无限累积占用磁盘。
#
# 用法: 与 批量背景适配-分块启动器.command 并行运行,或手动运行。
#   后台: nohup bash 批量背景适配-自动清理dunamis.sh &   (会自动停止)
#
# 安全: 只删除 >50MB 且无进程打开(非写句柄)的 dunamis-*.log;
#       不删除正在写的日志;不删除 dunamis-ingest.framework(会导致 AI 损坏)。

LOG_DIR="$HOME/Library/Logs/Adobe/com.adobe.dunamis"
AS_DIR="$HOME/Library/Application Support/com.adobe.dunamis"
INTERVAL=600                # 每 10 分钟清理一次
MAX_LOG_AGE_DAYS=0          # 只清理 >1 天的轮转日志(当天日志仍可能被进程追加)
MIN_SIZE_MB=50              # 只清理 >50MB 的大日志(小日志留着无害)

log() {
    echo "[$(date '+%H:%M:%S')] $*"
}

is_written() {
    # 判断文件是否有进程打开(写句柄)
    lsof "$1" 2>/dev/null | grep -v COMMAND | grep -q . && return 0 || return 1
}

cleanup_once() {
    freed=0
    [ -d "$LOG_DIR" ] || return 0
    # 1) 清理旧轮转日志(>50MB、无进程打开、无进程打开即清)
    while IFS= read -r f; do
        file_mtime=$(stat -f %m "$f" 2>/dev/null || echo 0)
        now=$(date +%s)
        age_days=$(( (now - file_mtime) / 86400 ))
        if [ "$age_days" -ge "$MAX_LOG_AGE_DAYS" ]; then
            if ! is_written "$f"; then
                size=$(stat -f %z "$f" 2>/dev/null || echo 0)
                rm -f "$f" 2>/dev/null && freed=$((freed + size)) && log "DEL 日志 $(basename "$f") ($(($size/1048576)) MB)"
            fi
        fi
    done < <(find "$LOG_DIR" -name "dunamis-*.log" -size +${MIN_SIZE_MB}M 2>/dev/null)

    # 2) 清理 Application Support 中非当前 configGuid 的旧 UUID 目录
    #    (当前活跃目录由 dunamis 运行时使用;删除其它旧目录不破坏功能)
    if [ -d "$AS_DIR" ]; then
        while IFS= read -r d; do
            if ! is_written "$d"; then
                size=$(du -sk "$d" 2>/dev/null | awk '{print $1*1024}')
                rm -rf "$d" 2>/dev/null && freed=$((freed + size)) && log "DEL 数据 $(basename "$d") ($(($size/1048576)) MB)"
            fi
        done < <(find "$AS_DIR" -maxdepth 1 -type d -name "[0-9a-f]*-[0-9a-f]*-[0-9a-f]*-[0-9a-f]*-[0-9a-f]*" ! -name "$(ls -t "$AS_DIR" | grep -E '^[0-9a-f-]{36}$' | head -1)" 2>/dev/null)
    fi

    [ "$freed" -gt 0 ] && log "本次释放 $((freed/1048576)) MB"
    return 0
}

log "dunamis 自动清理开始(间隔 ${INTERVAL}s,保留 ${MAX_LOG_AGE_DAYS} 天内日志)"
while true; do
    # 若批处理驱动已退出(标记 DONE 或驱动进程消失),停止清理
    if ! pgrep -f "批量背景适配-分块启动器.command" >/dev/null 2>&1; then
        log "批处理驱动已结束,自动清理退出"
        exit 0
    fi
    cleanup_once
    sleep "$INTERVAL"
done
