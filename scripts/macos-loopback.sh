#!/usr/bin/env bash
# macOS only answers on 127.0.0.1; Linux answers on the whole 127.0.0.0/8. The API tests act as many different clients
# (each "client" is its own loopback address, to exercise the per-address rate limits), so on macOS add the aliases once:
#   sudo ./scripts/macos-loopback.sh          # add (lost at reboot)
#   sudo ./scripts/macos-loopback.sh remove
set -euo pipefail
[ "$(uname)" = "Darwin" ] || { echo "Not macOS: nothing to do (Linux already routes all of 127.0.0.0/8)."; exit 0; }
action="${1:-add}"
for i in $(seq 2 200); do
  if [ "$action" = "remove" ]; then ifconfig lo0 -alias "127.0.0.$i" 2>/dev/null || true
  else ifconfig lo0 alias "127.0.0.$i" up; fi
done
echo "done: 127.0.0.2 … 127.0.0.200 ($action)"
