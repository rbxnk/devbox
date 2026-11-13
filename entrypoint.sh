#!/bin/sh
set -eu

lanblock.sh   # fails closed: no rules, no sshd

[ -n "${AUTHORIZED_KEYS:-}${DEV_PASSWORD:-}" ] || { echo "devbox: set AUTHORIZED_KEYS or DEV_PASSWORD, or nobody can log in" >&2; exit 1; }
printf '%s\n' "${AUTHORIZED_KEYS:-}" | tr ';' '\n' > /etc/ssh/authorized_keys/dev
chmod 644 /etc/ssh/authorized_keys/dev
# Password login only when DEV_PASSWORD is set; '*' (no password, not locked) otherwise.
if [ -n "${DEV_PASSWORD:-}" ]; then
  printf 'dev:%s\n' "$DEV_PASSWORD" | chpasswd
  echo "PasswordAuthentication yes" > /etc/ssh/sshd_config.d/00-password.conf
else
  usermod -p '*' dev
  echo "PasswordAuthentication no" > /etc/ssh/sshd_config.d/00-password.conf
fi
unset DEV_PASSWORD   # before anything runs as dev, which could read it from /proc
key=/etc/ssh/keys/ssh_host_ed25519_key
[ -f "$key" ] || ssh-keygen -q -t ed25519 -N '' -f "$key"

# herdr-core ties its identity to /etc/machine-id, which each image build makes anew; a new one
# reads as a different machine to the herdr apps. Keep one for good, starting from herdr-core's.
mid=/etc/ssh/keys/machine-id
if [ ! -s "$mid" ]; then
  sed -n 's/.*"machine_id": *"\([0-9a-f]\{32\}\)".*/\1/p' /home/dev/.local/state/herdr-core/default/core.json 2>/dev/null > "$mid" || true
  [ -s "$mid" ] || cat /proc/sys/kernel/random/uuid | tr -d '-' > "$mid"
fi
cat "$mid" > /etc/machine-id

# The home folder starts empty (Docker creates a missing folder as root): give it to dev, add the default shell files.
chown dev:dev /home/dev
chmod 1777 /tmp   # the tmp folder is created root-only too
[ -f /home/dev/.profile ] || runuser -u dev -- cp -rn /etc/skel/. /home/dev/

# Installed into the home folder on first start, so they update themselves and survive rebuilds.
runuser -u dev -- bash -c 'set -eo pipefail
  [ -x ~/.local/bin/claude ] || curl -fsSL https://claude.ai/install.sh | bash
  [ -x ~/.local/bin/herdr ]  || curl -fsSL https://herdr.dev/install.sh | sh
  [ -x ~/.local/bin/herdr-core ] || curl -fsSL https://releases.herdr.dev/core/install.sh | sh
  # Claude Code hook: herdr (agent state in its sidebar). Idempotent.
  ~/.local/bin/herdr integration install claude >/dev/null
' || echo "devbox: installing claude, herdr or herdr-core failed; restart the container to retry" >&2

# Daemons for herdr-core (the server the herdr apps connect to) and the herdr PWA.
# There's no systemd here, so a loop keeps each running, and restarts it after an update.
# A login shell, so they (and the terminals herdr-core starts) get bash and dev's full PATH.
runuser -l dev -c 'while :; do ~/.local/bin/herdr-core serve >/dev/null 2>&1; sleep 5; done' &
# The herdr PWA's bridge (pwa/), on 8787 for the host's reverse proxy. The image's own Node, not a
# mise one that may be older. Its token is in ~/.config/herdr-pwa/token; its last run's output in /tmp.
# A copy deployed from the box (pwa/deploy.sh) to ~/.local/share/herdr-pwa wins over the image's; delete it to go back.
runuser -l dev -c 'while :; do d=/opt/herdr-pwa; [ -f ~/.local/share/herdr-pwa/server/main.ts ] && d=~/.local/share/herdr-pwa
  /usr/bin/node "$d/server/main.ts" >/tmp/herdr-pwa.log 2>&1; sleep 5; done' &

exec /usr/sbin/sshd -D -e
