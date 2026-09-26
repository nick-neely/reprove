#!/bin/sh
# PROTOTYPE for #135. ADR 0031 §6: the patched bridge must exit before binding on a missing or malformed token.
# Runs as root on port 3001, never the Pass's bridge. The valid case is a control and must bind.
valid=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
run() {
  name=$1; shift
  dir=/tmp/p135-refusal/$name; mkdir -p "$dir"
  env "$@" BRIDGE_WS_PORT=3001 timeout 6 node /opt/reprove/codex/bridge.mjs --workdir /tmp --bridge-state-dir "$dir" --cli-shim-dir "$dir/shim" > "$dir/out" 2> "$dir/err"
  code=$?
  if grep -q bridge-ready "$dir/out"; then bound=yes; else bound=no; fi
  echo "refusal[$name] exit=$code bound=$bound stderr=$(head -c 160 "$dir/err" | tr '\n' ' ')"
}
run unset -u BRIDGE_CHANNEL_TOKEN
run empty BRIDGE_CHANNEL_TOKEN=
run short BRIDGE_CHANNEL_TOKEN=abc
run hex63 BRIDGE_CHANNEL_TOKEN=${valid%?}
run hex65 BRIDGE_CHANNEL_TOKEN=${valid}0
run upper BRIDGE_CHANNEL_TOKEN=$(echo $valid | tr a-f A-F)
run nonhex BRIDGE_CHANNEL_TOKEN=${valid%?}g
run valid BRIDGE_CHANNEL_TOKEN=$valid
