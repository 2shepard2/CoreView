#!/bin/bash
# Optional: let only your reverse proxy reach CoreView Studio's ports.
# Docker publishes ports before the host firewall sees them, so this drops
# other sources in the raw table (pre-DNAT). Settings in
# /etc/default/coreview-studio-ingress:
#   PROXY_IP=192.0.2.10   # the reverse proxy allowed in
#   HOST_IP=192.0.2.20    # the address the ports are published on (BIND_ADDRESS)
#   IFACE=eth0            # the LAN interface
# Install: copy to /usr/local/sbin/coreview-studio-ingress.sh, add the unit
# (coreview-studio-ingress.service), systemctl enable --now coreview-studio-ingress.
set -euo pipefail
[ -r /etc/default/coreview-studio-ingress ] && . /etc/default/coreview-studio-ingress
: "${PROXY_IP:?set PROXY_IP in /etc/default/coreview-studio-ingress}"
: "${HOST_IP:?set HOST_IP in /etc/default/coreview-studio-ingress}"
IFACE="${IFACE:-eth0}"
exec 9>/run/lock/coreview-studio-ingress.lock
flock 9
ipt() { iptables -w 10 "$@"; }
ports=(${PORTS:-3216 3217})
chain=CV-STUDIO-RAW
rule() { echo -i "$IFACE" -d "$HOST_IP/32" -p tcp --dport "$1" -m comment --comment coreview-studio-ingress -j "$chain"; }
case "${1:-apply}" in
  apply)
    ipt -t raw -S "$chain" >/dev/null 2>&1 || ipt -t raw -N "$chain"
    ipt -t raw -C "$chain" -s "$PROXY_IP/32" -j RETURN 2>/dev/null || \
      ipt -t raw -A "$chain" -s "$PROXY_IP/32" -j RETURN
    ipt -t raw -C "$chain" -j DROP 2>/dev/null || ipt -t raw -A "$chain" -j DROP
    for port in "${ports[@]}"; do
      ipt -t raw -C PREROUTING $(rule "$port") 2>/dev/null || ipt -t raw -I PREROUTING 1 $(rule "$port")
    done
    ;;
  check)
    for port in "${ports[@]}"; do ipt -t raw -C PREROUTING $(rule "$port"); done
    ipt -t raw -C "$chain" -s "$PROXY_IP/32" -j RETURN
    ipt -t raw -C "$chain" -j DROP
    ;;
  remove)
    published_ports=$(docker ps --format '{{.Ports}}')
    for port in "${ports[@]}"; do
      if grep -q "${HOST_IP}:${port}->" <<< "$published_ports"; then
        echo "Refusing removal while Studio port ${port} is published" >&2
        exit 1
      fi
    done
    for port in "${ports[@]}"; do
      while ipt -t raw -C PREROUTING $(rule "$port") 2>/dev/null; do ipt -t raw -D PREROUTING $(rule "$port"); done
    done
    ipt -t raw -F "$chain"
    ipt -t raw -X "$chain"
    ;;
  *) echo 'usage: ingress-guard.sh apply|check|remove' >&2; exit 2 ;;
esac
