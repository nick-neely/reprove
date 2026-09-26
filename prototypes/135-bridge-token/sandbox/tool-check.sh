#!/bin/sh
# PROTOTYPE for #135. Run by Codex as a real tool call; reports facts, never values of secrets.
out=/tmp/p135-tool-check.txt
{
echo "uid=$(id -u) user=$(id -un) groups=$(id -G)"
echo "no_new_privs=$(awk '/^NoNewPrivs/{print $2}' /proc/self/status)"
echo "bridge_vars_in_env=$(env | cut -d= -f1 | grep -c '^BRIDGE_')"
echo "env_names=$(env | cut -d= -f1 | sort | tr '\n' ' ')"
echo "HOME=$HOME owner=$(stat -c %U "$HOME" 2>&1)"
if [ -n "${CODEX_HOME-}" ]; then echo "CODEX_HOME=$CODEX_HOME owner=$(stat -c %U "$CODEX_HOME" 2>&1)"; else echo "CODEX_HOME=<unset in tool env> /home/reviewer/.codex owner=$(stat -c %U /home/reviewer/.codex 2>&1)"; fi
sudo -n true >/dev/null 2>&1; echo "sudo_exit=$?"
ls /vercel/sandbox/.agent-runs >/dev/null 2>&1; echo "agent_runs_list_exit=$?"
echo "tls_curl=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 https://api.openai.com/v1/models 2>&1)"
echo "tls_node=$(node -e 'fetch("https://api.openai.com/v1/models").then(r=>console.log(r.status),e=>console.log("error:"+(e.cause?.code??e.message)))' 2>&1)"
echo "PPID=$PPID ppid_comm=$(cat /proc/$PPID/comm 2>&1)"
pid=$$; i=0
while [ "$pid" -gt 1 ] && [ $i -lt 12 ]; do
  ppid=$(awk '/^PPid/{print $2}' "/proc/$pid/status")
  [ "${ppid:-0}" -ge 1 ] || break
  comm=$(cat "/proc/$ppid/comm" 2>/dev/null); puid=$(awk '/^Uid/{print $2}' "/proc/$ppid/status")
  if cat "/proc/$ppid/environ" > "/tmp/p135-env.$$" 2>/dev/null; then
    r=readable; b=$(tr '\0' '\n' < "/tmp/p135-env.$$" | cut -d= -f1 | grep -c '^BRIDGE_')
    echo "ancestor_env_names[$i]=$(tr '\0' '\n' < "/tmp/p135-env.$$" | sed -n 's/^\([^=]*\)=.*/\1/p' | sort -u | tr '\n' ' ')"
  else r=denied; b=-; fi
  rm -f "/tmp/p135-env.$$"
  echo "ancestor[$i] pid=$ppid comm=$comm uid=$puid environ=$r bridge_vars=$b"
  pid=$ppid; i=$((i+1))
done
} > "$out" 2>&1
cat "$out"
sleep 6
