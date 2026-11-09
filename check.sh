#!/bin/bash
# Run inside the devbox: check.sh [LAN-IP ...]
# The internet must answer; the gateway (the host) and each LAN IP must time out.
fail=0
if curl -fsS -m 10 -o /dev/null https://github.com; then echo "ok   internet"; else echo "FAIL internet"; fail=1; fi

gw=$(awk '$2=="00000000"{print $3; exit}' /proc/net/route)
gw=$(printf '%d.%d.%d.%d' 0x${gw:6:2} 0x${gw:4:2} 0x${gw:2:2} 0x${gw:0:2})
for ip in "$gw" "$@"; do
  curl -sS --connect-timeout 3 -o /dev/null "http://$ip/" 2>/dev/null
  # 28 = timed out, i.e. dropped. Anything else (even "refused") means it was reachable.
  if [ $? -eq 28 ]; then echo "ok   $ip blocked"; else echo "FAIL $ip reachable"; fail=1; fi
done
exit $fail
