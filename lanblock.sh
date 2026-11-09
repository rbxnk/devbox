#!/bin/sh
# Runs on the host's network: keeps the devbox subnet off the LAN, the host and other containers.
set -eu
: "${SUBNET:?}"

# Use the iptables backend Docker writes to (legacy on Unraid, nft on most distros).
for ipt in iptables-nft iptables-legacy; do
  "$ipt" -S DOCKER-USER >/dev/null 2>&1 && break
  ipt=
done
[ -n "$ipt" ] || { echo "lanblock: no DOCKER-USER chain in either iptables backend (is Docker using its nftables firewall?)" >&2; exit 1; }
echo "lanblock: using $ipt"
iptables() { "$ipt" "$@"; }

for c in DEVBOX-FWD DEVBOX-IN; do iptables -N "$c" 2>/dev/null || iptables -F "$c"; done

# Replies to connections that came in (your SSH and mosh sessions) still pass.
iptables -A DEVBOX-FWD -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16; do
  iptables -A DEVBOX-FWD -d "$net" -j DROP
done
# Traffic to the host's own addresses goes through INPUT, not DOCKER-USER.
iptables -A DEVBOX-IN -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -A DEVBOX-IN -j DROP

iptables -C DOCKER-USER -s "$SUBNET" -j DEVBOX-FWD 2>/dev/null || iptables -I DOCKER-USER -s "$SUBNET" -j DEVBOX-FWD
iptables -C INPUT -s "$SUBNET" -j DEVBOX-IN 2>/dev/null || iptables -I INPUT -s "$SUBNET" -j DEVBOX-IN

echo "lanblock: rules in place for $SUBNET"
touch /tmp/ready
# Rules stay when this stops: failing closed is the point.
exec sleep infinity
