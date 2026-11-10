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

# The home folder starts empty (Docker creates a missing folder as root): give it to dev, add the default shell files.
chown dev:dev /home/dev
chmod 1777 /tmp   # the tmp folder is created root-only too
[ -f /home/dev/.profile ] || runuser -u dev -- cp -rn /etc/skel/. /home/dev/

# Installed into the home folder on first start, so they update themselves and survive rebuilds.
runuser -u dev -- bash -c 'set -eo pipefail
  [ -x ~/.local/bin/claude ] || curl -fsSL https://claude.ai/install.sh | bash
  [ -x ~/.local/bin/herdr ]  || curl -fsSL https://herdr.dev/install.sh | sh
  [ -x ~/.local/bin/moshi-hook ] || curl -fsSL https://getmoshi.app/install.sh | MOSHI_HOOK_SKIP_FIRST_RUN=1 sh
  # Claude Code hooks: herdr (agent state in its sidebar) and Moshi (phone notifications, approvals). Both are idempotent.
  ~/.local/bin/herdr integration install claude >/dev/null
  ~/.local/bin/moshi-hook install --target claude >/dev/null
' || echo "devbox: installing claude, herdr or moshi-hook failed; restart the container to retry" >&2

# Pair with the Moshi app once, if a token was given (Moshi: Settings -> Integrations).
if [ -n "${MOSHI_PAIRING_TOKEN:-}" ] && runuser -u dev -- ~dev/.local/bin/moshi-hook status 2>/dev/null | grep -q '^status: unpaired'; then
  runuser -u dev -- ~dev/.local/bin/moshi-hook pair --store file --token "$MOSHI_PAIRING_TOKEN" \
    || echo "devbox: Moshi pairing failed; check MOSHI_PAIRING_TOKEN" >&2
fi
unset MOSHI_PAIRING_TOKEN   # the daemon runs as dev, so agents could read it from /proc
# The Moshi daemon; there's no systemd here, so a loop keeps it running.
runuser -u dev -- sh -c 'while :; do ~/.local/bin/moshi-hook serve >/dev/null 2>&1; sleep 10; done' &

exec /usr/sbin/sshd -D -e
