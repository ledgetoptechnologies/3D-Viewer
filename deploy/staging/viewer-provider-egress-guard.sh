#!/bin/sh
# Narrow egress for the isolated staging Viewer API/worker. Install this
# root-owned script on the staging host and call it only from the supervised
# viewer-staging.service pre-start hook.
set -eu

readonly EDGE_NETWORK='viewer-staging_viewer-edge'
readonly PRIVATE_NETWORK='viewer-staging_viewer-private'
readonly EDGE_SUBNET='172.23.0.0/16'
readonly VIEWER_PROXY='172.23.0.2'
readonly VIEWER_API='172.23.0.3'
readonly VIEWER_WORKER='172.23.0.4'
readonly CLUSTERODM='192.168.50.89'
readonly CLUSTERODM_PORT='4000'
readonly VIEWER_HOST='192.168.50.90'
readonly VIEWER_HTTPS_PORT='8088'
readonly CONTAINER_HTTP_PORT='8088'
readonly V4_EGRESS_CHAIN='LTDS_VW_STG_EGR'
readonly V4_INPUT_CHAIN='LTDS_VW_STG_IN'
readonly V6_GUARD_CHAIN='LTDS_VW_STG_V6'

die() { printf '%s\n' "viewer staging egress guard: $*" >&2; exit 1; }

assert_edge_members() {
  members=$(docker network inspect "$EDGE_NETWORK" --format '{{range .Containers}}{{println .Name .IPv4Address}}{{end}}') || die 'edge network missing'
  printf '%s\n' "$members" | while read -r name address remainder; do
    case "$name:$address:$remainder" in
      ::|viewer-staging-viewer-proxy-1:172.23.0.2/16:|viewer-staging-viewer-api-1:172.23.0.3/16:|viewer-staging-viewer-worker-1:172.23.0.4/16:) ;;
      *) die 'edge bridge has an unexpected member or address; refusing policy changes' ;;
    esac
  done
}

ensure_v4_jump() {
  parent=$1 chain=$2
  while iptables -w 5 -C "$parent" -j "$chain" 2>/dev/null; do
    iptables -w 5 -D "$parent" -j "$chain"
  done
  iptables -w 5 -I "$parent" 1 -j "$chain"
}

remove_v4_jump() {
  parent=$1 chain=$2
  while iptables -w 5 -C "$parent" -j "$chain" 2>/dev/null; do
    iptables -w 5 -D "$parent" -j "$chain"
  done
}

ensure_v6_jump() {
  parent=$1 chain=$2
  while ip6tables -w 5 -C "$parent" -j "$chain" 2>/dev/null; do
    ip6tables -w 5 -D "$parent" -j "$chain"
  done
  ip6tables -w 5 -I "$parent" 1 -j "$chain"
}

remove_v6_jump() {
  parent=$1 chain=$2
  while ip6tables -w 5 -C "$parent" -j "$chain" 2>/dev/null; do
    ip6tables -w 5 -D "$parent" -j "$chain"
  done
}

remove_rules() {
  assert_edge_members
  attached=$(docker network inspect "$EDGE_NETWORK" --format '{{range .Containers}}{{println .Name}}{{end}}') || die 'edge network missing'
  printf '%s\n' "$attached" | grep -Eq 'viewer-staging-viewer-(api|worker)-' \
    && die 'refusing to remove egress rules while Viewer API/worker remain attached to the edge bridge'

  remove_v4_jump DOCKER-USER "$V4_EGRESS_CHAIN"
  remove_v4_jump INPUT "$V4_INPUT_CHAIN"
  for chain in "$V4_EGRESS_CHAIN" "$V4_INPUT_CHAIN"; do
    if iptables -w 5 -nL "$chain" >/dev/null 2>&1; then
      iptables -w 5 -F "$chain"
      iptables -w 5 -X "$chain"
    fi
  done

  if command -v ip6tables >/dev/null 2>&1; then
    bridge_id=$(docker network inspect "$EDGE_NETWORK" --format '{{.Id}}' | cut -c1-12)
    bridge="br-$bridge_id"
    remove_v6_jump INPUT "$V6_GUARD_CHAIN"
    remove_v6_jump FORWARD "$V6_GUARD_CHAIN"
    if ip6tables -w 5 -nL "$V6_GUARD_CHAIN" >/dev/null 2>&1; then
      ip6tables -w 5 -F "$V6_GUARD_CHAIN"
      ip6tables -w 5 -X "$V6_GUARD_CHAIN"
    fi
  fi
}

apply_rules() {
  # Rebuilding our chains is safe only before the supervised stack starts.
  # Existing stopped containers may remain attached to the preserved bridge.
  running=$(docker ps --filter label=com.docker.compose.project=viewer-staging --format '{{.Names}}')
  [ -z "$running" ] || die 'stop the supervised Viewer staging stack before applying policy'
  assert_edge_members
  command -v iptables >/dev/null 2>&1 || die 'iptables is unavailable'
  command -v ip6tables >/dev/null 2>&1 || die 'ip6tables is required for staging IPv6 containment'
  iptables -w 5 -nL DOCKER-USER >/dev/null 2>&1 || die 'Docker DOCKER-USER chain is unavailable'
  [ "$(docker network inspect "$EDGE_NETWORK" --format '{{(index .IPAM.Config 0).Subnet}}')" = "$EDGE_SUBNET" ] \
    || die 'staging edge bridge subnet differs from the reviewed value'
  [ "$(docker network inspect "$EDGE_NETWORK" --format '{{(index .IPAM.Config 0).Gateway}}')" = '172.23.0.1' ] \
    || die 'staging edge bridge gateway differs from the reviewed value'
  [ "$(docker network inspect "$EDGE_NETWORK" --format '{{.EnableIPv6}}')" = 'false' ] \
    || die 'staging edge bridge IPv6 must remain disabled'
  [ "$(sysctl -n net.ipv4.ip_forward)" = '1' ] || die 'IPv4 forwarding is not enabled'
  [ "$(sysctl -n net.ipv6.conf.all.forwarding)" = '0' ] || die 'host IPv6 forwarding must remain disabled'
  [ "$(docker network inspect "$PRIVATE_NETWORK" --format '{{.Internal}}')" = 'true' ] || die 'Viewer private bridge must remain internal'
  [ "$(docker network inspect "$PRIVATE_NETWORK" --format '{{.EnableIPv6}}')" = 'false' ] || die 'Viewer private bridge IPv6 must remain disabled'
  [ "$(docker network inspect "$PRIVATE_NETWORK" --format '{{(index .IPAM.Config 0).Subnet}}')" = '172.22.0.0/16' ] || die 'Viewer private subnet changed'
  private_members=$(docker network inspect "$PRIVATE_NETWORK" --format '{{range .Containers}}{{println .Name}}{{end}}') || die 'Viewer private bridge missing'
  printf '%s\n' "$private_members" | while read -r name; do
    case "$name" in
      ''|viewer-staging-viewer-api-1|viewer-staging-viewer-worker-1|viewer-staging-viewer-proxy-1) ;;
      *) die 'Viewer private bridge has an unexpected member' ;;
    esac
  done
  private_id=$(docker network inspect "$PRIVATE_NETWORK" --format '{{.Id}}' | cut -c1-12)
  private_bridge="br-$private_id"
  ip link show "$private_bridge" >/dev/null 2>&1 || die 'Viewer private bridge interface unavailable'

  iptables -w 5 -N "$V4_EGRESS_CHAIN" 2>/dev/null || true
  iptables -w 5 -F "$V4_EGRESS_CHAIN"
  # API and worker can contact only the approved ClusterODM service.
  for source in "$VIEWER_API" "$VIEWER_WORKER"; do
    iptables -w 5 -A "$V4_EGRESS_CHAIN" -s "$source" -d "$CLUSTERODM" -p tcp --dport "$CLUSTERODM_PORT" \
      -m conntrack --ctstate NEW,ESTABLISHED --ctdir ORIGINAL -j ACCEPT
    iptables -w 5 -A "$V4_EGRESS_CHAIN" -s "$CLUSTERODM" -d "$source" -p tcp --sport "$CLUSTERODM_PORT" \
      -m conntrack --ctstate ESTABLISHED --ctdir REPLY --ctorigsrc "$source" --ctorigdst "$CLUSTERODM" \
      --ctorigdstport "$CLUSTERODM_PORT" -j ACCEPT
    iptables -w 5 -A "$V4_EGRESS_CHAIN" -d "$source" \
      -m conntrack --ctstate RELATED --ctorigsrc "$source" --ctorigdst "$CLUSTERODM" \
      --ctorigdstport "$CLUSTERODM_PORT" -j ACCEPT
  done

  # Nginx may resolve viewer-api on the edge network as well as its private
  # network address. Permit only its upstream HTTP flow to the API.
  iptables -w 5 -A "$V4_EGRESS_CHAIN" -s "$VIEWER_PROXY" -d "$VIEWER_API" -p tcp --dport "$CONTAINER_HTTP_PORT" \
    -m conntrack --ctstate NEW,ESTABLISHED --ctdir ORIGINAL -j ACCEPT
  iptables -w 5 -A "$V4_EGRESS_CHAIN" -s "$VIEWER_API" -d "$VIEWER_PROXY" -p tcp --sport "$CONTAINER_HTTP_PORT" \
    -m conntrack --ctstate ESTABLISHED --ctdir REPLY --ctorigsrc "$VIEWER_PROXY" --ctorigdst "$VIEWER_API" \
    --ctorigdstport "$CONTAINER_HTTP_PORT" -j ACCEPT
  iptables -w 5 -A "$V4_EGRESS_CHAIN" -d "$VIEWER_PROXY" \
    -m conntrack --ctstate RELATED --ctorigsrc "$VIEWER_PROXY" --ctorigdst "$VIEWER_API" \
    --ctorigdstport "$CONTAINER_HTTP_PORT" -j ACCEPT

  # Preserve only replies to inbound browser traffic on the published Viewer
  # HTTPS port; do not grant Nginx arbitrary new outbound connections.
  iptables -w 5 -A "$V4_EGRESS_CHAIN" -s "$VIEWER_PROXY" -p tcp --sport 8443 \
    -m conntrack --ctstate ESTABLISHED --ctdir REPLY --ctorigdst "$VIEWER_HOST" \
    --ctorigdstport "$VIEWER_HTTPS_PORT" -j ACCEPT
  iptables -w 5 -A "$V4_EGRESS_CHAIN" -d "$VIEWER_PROXY" \
    -m conntrack --ctstate RELATED --ctorigdst "$VIEWER_HOST" --ctorigdstport "$VIEWER_HTTPS_PORT" -j ACCEPT

  # Fail closed for every other forwarded packet sourced by viewer-edge.
  iptables -w 5 -A "$V4_EGRESS_CHAIN" -s "$EDGE_SUBNET" -j REJECT --reject-with icmp-port-unreachable
  iptables -w 5 -A "$V4_EGRESS_CHAIN" -j RETURN
  ensure_v4_jump DOCKER-USER "$V4_EGRESS_CHAIN"

  # Docker's DOCKER-USER chain is FORWARD-only; prevent API/worker access to
  # host-local ports using the separate INPUT chain. The proxy may reply to
  # host-initiated health/browser connections, but cannot initiate host access.
  iptables -w 5 -N "$V4_INPUT_CHAIN" 2>/dev/null || true
  iptables -w 5 -F "$V4_INPUT_CHAIN"
  iptables -w 5 -A "$V4_INPUT_CHAIN" -s "$VIEWER_API" -j REJECT --reject-with icmp-port-unreachable
  iptables -w 5 -A "$V4_INPUT_CHAIN" -s "$VIEWER_WORKER" -j REJECT --reject-with icmp-port-unreachable
  iptables -w 5 -A "$V4_INPUT_CHAIN" -s "$VIEWER_PROXY" -m conntrack --ctstate NEW,INVALID,UNTRACKED -j REJECT --reject-with icmp-port-unreachable
  # Internal Docker bridges still permit host-gateway access via INPUT.
  # Block container-initiated host access through that path as well; ordinary
  # proxy-to-API communication remains on FORWARD and is unaffected.
  iptables -w 5 -A "$V4_INPUT_CHAIN" -i "$private_bridge" -m conntrack --ctstate NEW,INVALID,UNTRACKED -j REJECT --reject-with icmp-port-unreachable
  iptables -w 5 -A "$V4_INPUT_CHAIN" -j RETURN
  ensure_v4_jump INPUT "$V4_INPUT_CHAIN"

  if command -v ip6tables >/dev/null 2>&1; then
    bridge_id=$(docker network inspect "$EDGE_NETWORK" --format '{{.Id}}' | cut -c1-12)
    bridge="br-$bridge_id"
    ip link show "$bridge" >/dev/null 2>&1 || die 'staging edge bridge interface is unavailable'
    ip6tables -w 5 -N "$V6_GUARD_CHAIN" 2>/dev/null || true
    ip6tables -w 5 -F "$V6_GUARD_CHAIN"
    ip6tables -w 5 -A "$V6_GUARD_CHAIN" -i "$bridge" -j DROP
    ip6tables -w 5 -A "$V6_GUARD_CHAIN" -o "$bridge" -j DROP
    ip6tables -w 5 -A "$V6_GUARD_CHAIN" -i "$private_bridge" -j DROP
    ip6tables -w 5 -A "$V6_GUARD_CHAIN" -o "$private_bridge" -j DROP
    ip6tables -w 5 -A "$V6_GUARD_CHAIN" -j RETURN
    ensure_v6_jump INPUT "$V6_GUARD_CHAIN"
    ensure_v6_jump FORWARD "$V6_GUARD_CHAIN"
  fi
}

case "${1:-apply}" in
  apply) apply_rules ;;
  remove) remove_rules ;;
  *) die 'usage: viewer-provider-egress-guard.sh [apply|remove]' ;;
esac
