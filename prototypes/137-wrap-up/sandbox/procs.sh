#!/bin/sh
# PROTOTYPE for #137. Host-side, as root: every process of the Reviewer uid and every bridge process.
# usage: procs.sh [old-bridge-pid]
echo "reviewer:"
ps -u 2000 -o pid=,ppid=,pgid=,sid=,stat=,comm=,args= 2>/dev/null | cut -c1-160
echo "bridges:"
for p in $(pgrep -f 'bridge[.]mjs.? --workdir'); do echo "$p $(ps -o stat=,args= -p $p | cut -c1-120)"; done
if [ -n "${1:-}" ]; then [ -d "/proc/$1" ] && echo "old_bridge_alive=$1 $(ps -o stat=,comm= -p $1)" || echo "old_bridge_alive=no"; fi
# LISTEN (0A) on port 3000 (0BB8), IPv4 and IPv6.
echo "listen_3000=$(cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk '$2 ~ /:0BB8$/ && $4 == "0A"' | wc -l)"
echo "pid1=$(ps -o comm= -p 1)"
