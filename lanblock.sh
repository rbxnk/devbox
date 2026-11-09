#!/bin/sh
# Runs as root in the devbox's own network namespace, before sshd: keeps the box off
# the LAN, the host and other containers. The host's firewall is not touched.
set -u

rules() {
  "$1" -F OUTPUT &&
  "$1" -A OUTPUT -o lo -j ACCEPT &&
  # Replies to connections that came in (your SSH and mosh sessions) still pass.
  "$1" -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT &&
  for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16; do
    "$1" -A OUTPUT -d "$net" -j DROP || return 1
  done
}

# Whichever backend the host kernel supports; legacy first, as Docker on Unraid uses it.
for ipt in iptables-legacy iptables-nft; do
  if rules "$ipt"; then echo "lanblock: rules in place ($ipt)"; exit 0; fi
  "$ipt" -F OUTPUT 2>/dev/null
done
echo "lanblock: could not set the firewall rules; not starting" >&2
exit 1
