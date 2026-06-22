---
name: deploy
description: Deploy BnF Corpus Research to the cluster (platform-prod) — build & push the app + worker images, ensure the Scaleway secret is current, helm upgrade the chart, and verify the live site. Use when the user wants to "deploy", "ship", "push to prod", "release", "redeploy", "update the deployed app", "rebuild and deploy the images", or "roll out a new version". This is the cluster/Helm release loop, NOT the local docker-compose stack (that's the `run-local` skill).
---

# Deploy — BnF Corpus Research → platform-prod

The production release loop. Builds both images, syncs secrets, and `helm
upgrade`s the chart onto `platform-prod` (namespace `bnf`, host
`bnf.demo.alien.club`). Full reference: [helm/DEPLOY.md](../../../helm/DEPLOY.md).

> Today this is a **direct Helm release** (not ArgoCD). Don't `git push` / apply
> the ArgoCD app unless the user explicitly asks to move to GitOps.

## Fixed coordinates

| | |
|---|---|
| kube context | `platform-prod` |
| namespace | `bnf` |
| release | `bnf-demo-prod` |
| app image | `rg.fr-par.scw.cloud/ns-data-streaming/bnf-demo` |
| worker image | `rg.fr-par.scw.cloud/ns-data-streaming/bnf-demo-worker` |
| Scaleway secret | `bnf-demo-prod` (project `77c152cc-4d27-4d9b-a449-143df07bcaad`) |
| chart | `helm/bnf-demo-chart` |

## Procedure

Run from the repo root (`bnf/`). Stop and report on any failure — don't paper over it.

### 1. Pre-flight

```bash
npx tsc --noEmit          # 0 errors
npm run lint              # 0 errors
# chat-sdk must be published — the app Dockerfile pulls it from npm, not the tarball:
grep -q 'npm:@alien_intelligence/chat-sdk' package.json && grep -q 'registry.npmjs.org/@alien_intelligence/chat-sdk' package-lock.json \
  || echo "chat-sdk NOT wired to npm — see memory chat-sdk-npm-package; fix before building"
```

### 2. Pick the version / tag

Ask the user for the new version if they didn't say. Then bump in lock-step:

- `package.json` → `version`
- `helm/bnf-demo-chart/values.yaml` → `image.tag` **and** `worker.image.tag`
- `helm/bnf-demo-chart/Chart.yaml` → `version` (chart) and `appVersion` (app)

Set `TAG` to that value for the commands below. Image tags are immutable —
never reuse a tag for changed code.

### 3. Ensure the Scaleway secret is current

The chart's ExternalSecrets read one Scaleway secret (`bnf-demo-prod`) whose
value is a JSON object keyed by property name. Only touch it if a credential
changed or a property is missing. To inspect which properties exist (names only):

```bash
scw secret secret list name=bnf-demo-prod -o json | jq -r '.[0].id'
```

Required properties: `ANTHROPIC_API_KEY`, `BNF_MCP_TOKEN`, `CLUSTER_BEARER_TOKEN`,
`LANGFUSE_SECRET_KEY`, `SCW_S3_ACCESS_KEY`, `SCW_S3_SECRET_KEY`, `SCW_API_KEY`,
`GOOGLE_AI_API_KEY`, `RUNPOD_API_KEY`. To create/rotate, build the JSON from the
local env files (never echo secret values) and push a new version:

```bash
# write {PROP: value, ...} to secret.json from .env.local + worker/.env, then:
SECRET_ID=$(scw secret secret list name=bnf-demo-prod -o json | jq -r '.[0].id')
[ -z "$SECRET_ID" ] && SECRET_ID=$(scw secret secret create name=bnf-demo-prod \
  project-id=77c152cc-4d27-4d9b-a449-143df07bcaad -o json | jq -r .id)
scw secret version create secret-id=$SECRET_ID data=@secret.json
rm -f secret.json
```

### 4. Build + push BOTH images

There are two images — the app, and the worker (the BnF-specific piece). No
basePath build-arg; the app is served at root.

```bash
docker build -t rg.fr-par.scw.cloud/ns-data-streaming/bnf-demo:$TAG .
docker push     rg.fr-par.scw.cloud/ns-data-streaming/bnf-demo:$TAG

docker build -f worker/Dockerfile.worker \
  -t rg.fr-par.scw.cloud/ns-data-streaming/bnf-demo-worker:$TAG worker
docker push rg.fr-par.scw.cloud/ns-data-streaming/bnf-demo-worker:$TAG
```

The app build runs ~5–7 min — launch with `run_in_background: true` and poll the
log. The Prisma `libssl` warning on `node:24-slim` is **benign** (migrations
still apply).

### 5. Helm upgrade

```bash
helm upgrade --install bnf-demo-prod helm/bnf-demo-chart \
  --kube-context platform-prod \
  --namespace bnf --create-namespace \
  --timeout 4m
```

Confirm the release reached `deployed` (not `failed`):

```bash
helm --kube-context platform-prod -n bnf history bnf-demo-prod | tail -2
```

### 6. Verify

```bash
kubectl --context platform-prod -n bnf get pods                                          # all 1/1, worker restarts=0
curl -sS -o /dev/null -w "app %{http_code}\n"  https://bnf.demo.alien.club/              # 307 → /sign-in
curl -sS -o /dev/null -w "auth %{http_code}\n" https://bnf.demo.alien.club/api/auth/get-session  # 200
```

Report: live version, pod status, site codes. If a pod isn't Ready, pull its
logs before declaring success — never report "deployed" on unverified pods.

## Gotchas (learned the hard way)

- **Helm `failed` on `.spec.refreshInterval` conflict.** external-secrets
  normalizes `1h`→`1h0m0s` and owns the field; the chart already sets `1h0m0s`
  to match. If it resurfaces, keep the normalized form — don't `--force`.
- **Worker init `no attempt`.** The `wait-for-postgres` init-container must pass
  `-U <username>` (the pod runs as uid 1000, absent from the postgres image's
  passwd, so libpq's getpwuid fails). Already in the chart.
- **Worker restarts at boot** only if the init-container is removed — it gates
  on Postgres. A healthy deploy shows worker `restarts=0`.
- **NEVER** `kubectl delete application` or delete the postgres StatefulSet/PVC
  on `platform-prod` — cascades and destroys data (see platform CLAUDE.md).
- The generated Secrets (`bnf-demo-prod-postgres`, `bnf-demo-prod-app`) are
  `resource-policy: keep` — never delete them; they hold the Postgres password,
  `BETTER_AUTH_SECRET`, and `JOB_CALLBACK_SECRET`.
