#!/usr/bin/env bash
# Take bnf.demo.alien.club OUT of maintenance: point the VirtualService back at
# the app. Optionally tears down the maintenance workload (KEEP=1 to leave it).
set -euo pipefail
CTX="${KCTX:-platform-prod}"
NS=bnf

echo "[maint-off] pointing VirtualService -> bnf-demo-prod"
kubectl --context "$CTX" -n "$NS" patch virtualservice bnf-demo-prod-vs --type json \
  -p '[{"op":"replace","path":"/spec/http/0/route/0/destination/host","value":"bnf-demo-prod.bnf.svc.cluster.local"}]'

echo "[maint-off] verify:  curl -sS -o /dev/null -w '%{http_code}\n' https://bnf.demo.alien.club/  (expect 307 -> /fr/sign-in)"

if [ "${KEEP:-0}" != "1" ]; then
  echo "[maint-off] tearing down maintenance workload (set KEEP=1 to skip)"
  kubectl --context "$CTX" -n "$NS" delete deploy/bnf-maintenance svc/bnf-maintenance \
    configmap/bnf-maintenance-html configmap/bnf-maintenance-conf --ignore-not-found
fi
echo "[maint-off] DONE."
