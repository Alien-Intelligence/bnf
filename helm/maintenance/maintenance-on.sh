#!/usr/bin/env bash
# Put bnf.demo.alien.club into maintenance: stand up the maintenance nginx (if
# needed) and point the VirtualService at it. Idempotent. Reverse with
# maintenance-off.sh.
set -euo pipefail
CTX="${KCTX:-platform-prod}"
NS=bnf
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[maint-on] creating/refreshing maintenance configmaps + workload"
kubectl --context "$CTX" -n "$NS" create configmap bnf-maintenance-html \
  --from-file=index.html="$DIR/maintenance.html" \
  --dry-run=client -o yaml | kubectl --context "$CTX" apply -f -
kubectl --context "$CTX" -n "$NS" create configmap bnf-maintenance-conf \
  --from-file=default.conf="$DIR/nginx.conf" \
  --dry-run=client -o yaml | kubectl --context "$CTX" apply -f -
kubectl --context "$CTX" apply -f "$DIR/maintenance.yaml"

echo "[maint-on] waiting for maintenance pods to be ready"
kubectl --context "$CTX" -n "$NS" rollout status deploy/bnf-maintenance --timeout=90s

echo "[maint-on] pointing VirtualService -> bnf-maintenance"
kubectl --context "$CTX" -n "$NS" patch virtualservice bnf-demo-prod-vs --type json \
  -p '[{"op":"replace","path":"/spec/http/0/route/0/destination/host","value":"bnf-maintenance.bnf.svc.cluster.local"}]'

echo "[maint-on] DONE. Verify:  curl -sS -o /dev/null -w '%{http_code}\n' https://bnf.demo.alien.club/"
echo "           (expect 503 with the maintenance page)"
