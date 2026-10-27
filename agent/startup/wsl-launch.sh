#!/bin/sh
set -eu
if [ "$#" -ne 2 ]; then
  printf '%s\n' 'Usage: wsl-launch.sh CHECKOUT_PATH NODE_PATH' >&2
  exit 2
fi
root=$1
node=$2
case "$root:$node" in /*:/*) ;; *) printf '%s\n' 'Checkout and Node paths must be absolute.' >&2; exit 2 ;; esac
umask 077
log_dir=${XDG_STATE_HOME:-"$HOME/.local/state"}/neonbyte
mkdir -p "$log_dir"
log=$log_dir/agent.log
if [ -f "$log" ] && [ "$(wc -c < "$log")" -gt 1048576 ]; then
  mv -f "$log" "$log_dir/agent.previous.log"
fi
cd "$root"
exec "$node" "--env-file-if-exists=$root/.env" "$root/agent/dist/main.js" run >> "$log" 2>&1
