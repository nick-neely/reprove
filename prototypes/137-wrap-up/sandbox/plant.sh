#!/bin/sh
# PROTOTYPE for #137. As root: plant a Reviewer-uid survivor in its own session with TERM and HUP ignored
# and a double-forked grandchild in a further session, then list the Reviewer's processes.
setpriv --reuid=reviewer --regid=reviewer --init-groups --no-new-privs -- \
  setsid sh -c 'trap "" TERM HUP; (setsid sh -c "trap \"\" TERM HUP; exec sleep 9999" &); exec sleep 9998' \
  >/dev/null 2>&1 </dev/null &
sleep 0.5
ps -u 2000 -o pid=,ppid=,sid=,stat=,args= | cut -c1-120
