#!/bin/sh
# Runs on the VM (stdin of ssh): files, user, systemd unit, nginx location. Idempotent; backups first.
set -eu
id etcito-levels >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin etcito-levels
sudo mkdir -p /opt/etcito-levels /var/lib/etcito-levels
[ -f /opt/etcito-levels/server.mjs ] && sudo cp -a /opt/etcito-levels "/opt/etcito-levels.bak-$STAMP"
sudo install -m 644 /tmp/server.mjs /opt/etcito-levels/server.mjs
sudo chown etcito-levels:etcito-levels /var/lib/etcito-levels
sudo install -m 644 /tmp/etcito-levels.service /etc/systemd/system/etcito-levels.service
sudo systemctl daemon-reload
site=/etc/nginx/sites-enabled/assets.etcito.com
if ! sudo grep -q 'location /levels' "$site"; then
  sudo cp -a "$site" "/etc/nginx/assets.etcito.com.bak-$STAMP"
  # insert the snippet before the first `location /objects/` line of the 443 server block
  sudo python3 - "$site" /tmp/nginx-levels.conf <<'PY'
import sys
site, snip = sys.argv[1], open(sys.argv[2]).read()
snip = "\n".join(l for l in snip.splitlines() if not l.lstrip().startswith("#")) + "\n\n"
s = open(site).read()
i = s.index("    location /objects/")
open(site, "w").write(s[:i] + snip + s[i:])
PY
  sudo nginx -t
  sudo systemctl reload nginx
fi
echo "installed $STAMP"
