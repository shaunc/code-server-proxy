#!/bin/bash
# cull-zombie-host-bash.sh — one-time/periodic mitigation for
# code-server-proxy-bdr: kill host-bash processes (and their ssh
# attach clients) inside code-server containers whose window has no
# live browser connection. Work is never lost: terminal state lives
# in tmux sessions on the HOST; killing the container-side viewer
# only detaches the session. Detached sessions are then either
# reaped by the host reaper (unowned + idle-shell + aged) or picked
# up again by grab/adopt when the window reopens.
#
# Usage:
#   scripts/cull-zombie-host-bash.sh [--dry-run] [--idle-secs N] [--all]
#
#   --dry-run     list what would be killed, kill nothing
#   --idle-secs   heartbeat age (s) above which a container counts as
#                 idle (default 300)
#   --all         also cull containers WITH a live connection
#                 (disruptive: every terminal pane in the open window
#                 shows "exited" until reload; work still safe)
#
# Runs on the docker host (silk/rayon). Kills run as the container
# user "abc" because container root cannot signal abc's processes.

set -euo pipefail

DRY=0
IDLE_SECS=300
ALL=0
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY=1; shift;;
        --idle-secs) IDLE_SECS="$2"; shift 2;;
        --all) ALL=1; shift;;
        *) echo "unknown arg: $1" >&2; exit 1;;
    esac
done

count_sessions() {
    tmux list-sessions -F '#{session_name} #{session_attached}' \
        2>/dev/null | grep '^cs-' \
        | awk '{t++; if ($2 != "0") a++}
               END {printf "total=%d attached=%d", t + 0, a + 0}'
}

echo "before: $(count_sessions)"

now=$(date +%s)
total_killed=0
for c in $(docker ps --format '{{.Names}}' | grep '^code-server-'); do
    iid=${c#code-server-}
    hb=$(docker exec "$c" stat -c %Y \
        /config/.local/share/code-server/heartbeat 2>/dev/null || echo 0)
    age=$(( now - hb ))
    if [ "$ALL" -ne 1 ] && [ "$age" -le "$IDLE_SECS" ]; then
        n=$(docker exec -u abc "$c" bash -c \
            'pgrep -f "^/bin/bash /usr/local/bin/host-bash$" | wc -l' \
            2>/dev/null || echo '?')
        echo "skip ${iid:0:12} (connected, hb ${age}s ago, ${n} host-bash)"
        continue
    fi
    if [ "$DRY" -eq 1 ]; then
        n=$(docker exec -u abc "$c" bash -c \
            'pgrep -f "^/bin/bash /usr/local/bin/host-bash$" | wc -l' \
            2>/dev/null || echo 0)
        [ "${n:-0}" -gt 0 ] \
            && echo "WOULD kill ${n} host-bash in ${iid:0:12} (hb ${age}s)"
        continue
    fi
    # TERM the bash first (its TERM trap is deferred while the
    # foreground ssh runs), then TERM its children (ssh attach /
    # sleep); when the child exits the pending trap fires -> clean
    # 'exit 0', no reconnect-loop reattach.
    n=$(docker exec -u abc "$c" bash -c '
        count=0
        for p in $(pgrep -f "^/bin/bash /usr/local/bin/host-bash$"); do
            kill -TERM "$p" 2>/dev/null || continue
            for ch in $(pgrep -P "$p"); do
                kill -TERM "$ch" 2>/dev/null
            done
            count=$((count + 1))
        done
        echo "$count"' 2>/dev/null || echo 0)
    [ "${n:-0}" -gt 0 ] && echo "killed ${n} host-bash in ${iid:0:12} (hb ${age}s)"
    total_killed=$(( total_killed + ${n:-0} ))
done

if [ "$DRY" -eq 0 ]; then
    sleep 4
    echo "after:  $(count_sessions)  (killed ${total_killed} host-bash)"
    echo "detached idle leaks will drain on the next reaper ticks;"
    echo "watch: journalctl --user -u code-server-proxy | grep TMUX-CLEANUP"
fi
