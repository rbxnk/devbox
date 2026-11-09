#!/bin/sh
set -eu

printf '%s\n' "$AUTHORIZED_KEYS" | tr ';' '\n' > /etc/ssh/authorized_keys/dev
chmod 644 /etc/ssh/authorized_keys/dev
key=/etc/ssh/keys/ssh_host_ed25519_key
[ -f "$key" ] || ssh-keygen -q -t ed25519 -N '' -f "$key"

# The home folder starts empty (Docker creates a missing folder as root): give it to dev, add the default shell files.
chown dev:dev /home/dev
chmod 1777 /tmp   # the tmp folder is created root-only too
[ -f /home/dev/.profile ] || runuser -u dev -- cp -rn /etc/skel/. /home/dev/

# Installed into the home folder on first start, so they update themselves and survive rebuilds.
runuser -u dev -- bash -c 'set -eo pipefail
  [ -x ~/.local/bin/claude ] || curl -fsSL https://claude.ai/install.sh | bash
  [ -x ~/.local/bin/herdr ]  || curl -fsSL https://herdr.dev/install.sh | sh
' || echo "devbox: installing claude or herdr failed; restart the container to retry" >&2

exec /usr/sbin/sshd -D -e
