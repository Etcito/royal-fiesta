#!/bin/sh
# Deploys the levels service to the Etcito VM (run from the royal-fiesta checkout, node on PATH).
#   ETCITO_SSH=user@host  LEVELS_KEY_FILE=<untracked file holding the write key; created when missing>  sh tools/levels/deploy.sh
# Restarts ONLY etcito-levels; timestamped backup of /opt/etcito-levels and of the nginx site first. Never prints the key.
set -eu
: "${ETCITO_SSH:?set ETCITO_SSH=user@host}"
: "${LEVELS_KEY_FILE:?set LEVELS_KEY_FILE to an untracked key file}"
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out=${LEVELS_BUILD_DIR:?set LEVELS_BUILD_DIR to a throwaway folder (any scratch folder)}
mkdir -p "$out"
[ -n "${LEVELS_PREBUILT:-}" ] || "$root/node_modules/.bin/rolldown" "$root/tools/levels/server.ts" --platform node --format esm -o "$out/server.mjs" >/dev/null
if [ ! -s "$LEVELS_KEY_FILE" ]; then
  (umask 077; head -c 36 /dev/urandom | base64 | tr -d '=+/\n' > "$LEVELS_KEY_FILE")
fi
stamp=$(date +%Y%m%d-%H%M%S)
scp -q "$out/server.mjs" "$here/etcito-levels.service" "$here/nginx-levels.conf" "$ETCITO_SSH:/tmp/"
ssh "$ETCITO_SSH" "STAMP=$stamp sh -s" < "$here/remote-install.sh"
# the key goes over stdin into a root-only file, only when the file does not exist yet
if ssh "$ETCITO_SSH" 'sudo test -s /etc/etcito-levels.env'; then echo "key file on the VM kept"; else
  { printf 'LEVELS_WRITE_KEY='; cat "$LEVELS_KEY_FILE"; printf '\n'; } | ssh "$ETCITO_SSH" 'sudo sh -c "umask 077; cat > /etc/etcito-levels.env"'
  echo "key file on the VM written"
fi
ssh "$ETCITO_SSH" 'sudo systemctl enable etcito-levels >/dev/null 2>&1; sudo systemctl restart etcito-levels; sleep 1; systemctl is-active etcito-levels; curl -s -o /dev/null -w "health %{http_code}\n" http://127.0.0.1:9790/health'
