#!/bin/sh
# PROTOTYPE for #137. ADR 0032 §5 step 3, as root: SIGKILL every process of the Reviewer uid, then prove
# quiescence: no process of that uid (zombies included), the old bridge's pid gone, nothing listening on
# its port. Prints what it saw and exits 0 only when every condition holds.
# usage: quiesce.sh <old-bridge-pid>
old=$1
rounds=0
while [ $rounds -lt 50 ]; do
  pkill -KILL -u 2000 2>/dev/null
  rounds=$((rounds + 1))
  left=$(ps -u 2000 -o pid= 2>/dev/null | wc -l)
  [ "$left" -eq 0 ] && break
  sleep 0.1
done
zombies=$(ps -u 2000 -o stat= 2>/dev/null | grep -c '^Z')
alive=$(ps -u 2000 -o pid= 2>/dev/null | wc -l)
if [ -d "/proc/$old" ]; then old_alive=yes; else old_alive=no; fi
listen=$(cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk '$2 ~ /:0BB8$/ && $4 == "0A"' | wc -l)
echo "rounds=$rounds reviewer_left=$alive zombies=$zombies old_bridge_alive=$old_alive listen_3000=$listen"
ps -u 2000 -o pid=,ppid=,stat=,comm= 2>/dev/null | sed 's/^/left: /'
[ "$alive" -eq 0 ] && [ "$old_alive" = no ] && [ "$listen" -eq 0 ]
