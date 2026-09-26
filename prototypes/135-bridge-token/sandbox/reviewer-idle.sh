#!/bin/sh
# PROTOTYPE for #135. ADR 0031 §7 bridge checks, run as the Reviewer uid against the idle bridge.
# usage: reviewer-idle.sh <session-id> <pid>...
session=$1; shift
echo "uid=$(id -u) user=$(id -un) groups=$(id -G)"
echo "no_new_privs=$(awk '/^NoNewPrivs/{print $2}' /proc/self/status)"
sudo -n true >/dev/null 2>&1; echo "sudo_exit=$?"
for p in "$@"; do
  cat "/proc/$p/environ" >/dev/null 2>&1; echo "environ_read_exit[$p]=$?"
done
ls /vercel/sandbox/.agent-runs >/dev/null 2>&1; echo "agent_runs_list_exit=$?"
ls "/vercel/sandbox/.agent-runs/$session/bridge" >/dev/null 2>&1; echo "bridge_dir_list_exit=$?"
cat "/vercel/sandbox/.agent-runs/$session/bridge/bridge-meta.json" >/dev/null 2>&1; echo "bridge_meta_read_exit=$?"
cat "/vercel/sandbox/.agent-runs/$session/bridge/event-log.ndjson" >/dev/null 2>&1; echo "event_log_read_exit=$?"
node /opt/reprove-proof/ws-probe.mjs
