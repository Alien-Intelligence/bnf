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
| broker image | `rg.fr-par.scw.cloud/ns-data-streaming/bnf-demo-broker` (BnF egress chokepoint, single replica) |
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
- `helm/bnf-demo-chart/values.yaml` → `image.tag`, `worker.image.tag` **and** `broker.image.tag`
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
`GOOGLE_AI_API_KEY`, `RUNPOD_API_KEY`, `BNF_CLIENT_KEY`, `BNF_CLIENT_SECRET`
(the last two are the BnF OAuth client_credentials — they live ONLY behind the
broker; the app and worker hold no BnF credentials). Plus `OPENROUTER_API_KEY`
**when `config.agentProvider: openrouter`** (the current prod default — the
default model GLM 5.2 routes through OpenRouter, so the app refuses to boot
without it). To ADD/rotate one property
without clobbering the rest, merge into the live version rather than rebuilding
the whole JSON (never echo secret values):

```bash
SECRET_ID=$(scw secret secret list name=bnf-demo-prod -o json | jq -r '.[0].id')
scw secret version access secret-id=$SECRET_ID revision=latest -o json | jq -r '.data' | base64 -d \
  | jq --arg k "$BNF_CLIENT_KEY" --arg s "$BNF_CLIENT_SECRET" '. + {BNF_CLIENT_KEY:$k, BNF_CLIENT_SECRET:$s}' > secret.json
jq -r 'keys[]' secret.json   # verify names only, never values
scw secret version create secret-id=$SECRET_ID data=@secret.json
shred -u secret.json
```

To create the secret from scratch instead (first deploy), build the JSON from the
local env files (never echo secret values) and push a new version:

```bash
# write {PROP: value, ...} to secret.json from .env.local + worker/.env, then:
SECRET_ID=$(scw secret secret list name=bnf-demo-prod -o json | jq -r '.[0].id')
[ -z "$SECRET_ID" ] && SECRET_ID=$(scw secret secret create name=bnf-demo-prod \
  project-id=77c152cc-4d27-4d9b-a449-143df07bcaad -o json | jq -r .id)
scw secret version create secret-id=$SECRET_ID data=@secret.json
rm -f secret.json
```

### 4. Build + push ALL THREE images

There are three images — the app, the worker (ingest), and the broker (the BnF
egress chokepoint). No basePath build-arg; the app is served at root. The broker
and worker are tiny Node images (seconds); the app is the slow one.

```bash
# app (slow — run in background, poll the log)
docker build -t rg.fr-par.scw.cloud/ns-data-streaming/bnf-demo:$TAG .
docker push     rg.fr-par.scw.cloud/ns-data-streaming/bnf-demo:$TAG

# worker (V2 — the staged-bucket pipeline; replaced V1 ./worker, clean break.
# Same image repo name, now built from worker-v2/ — no values.yaml change.)
docker build -f worker-v2/Dockerfile \
  -t rg.fr-par.scw.cloud/ns-data-streaming/bnf-demo-worker:$TAG worker-v2
docker push rg.fr-par.scw.cloud/ns-data-streaming/bnf-demo-worker:$TAG

# broker (context = broker/; its own Dockerfile)
docker build -t rg.fr-par.scw.cloud/ns-data-streaming/bnf-demo-broker:$TAG broker
docker push rg.fr-par.scw.cloud/ns-data-streaming/bnf-demo-broker:$TAG
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
kubectl --context platform-prod -n bnf get pods                                          # all 1/1, worker+broker restarts=0
curl -sS -o /dev/null -w "app %{http_code}\n"  https://bnf.demo.alien.club/              # 307 → /sign-in
curl -sS -o /dev/null -w "auth %{http_code}\n" https://bnf.demo.alien.club/api/auth/get-session  # 200

# Broker smoke (in-cluster). Startup banner must show the caps AND
# `api=https://openapiproext.bnf.fr` (the token'd host — NOT openapi.bnf.fr, which
# is the public no-token anonymous-IP mirror that 200s WITHOUT valid creds and so
# can't detect an OAuth failure). One /fetch on the ungated OAI host proves the
# proxy; one partner manifest on openapiproext proves OAuth mint
# (200 = creds valid; 401/403 = creds rejected; 502 "token error" = bad KEY/SECRET).
# Use the right Accept per resource: manifest/info.json → application/json,
# alto.xml → application/xml (asking for json on an XML resource returns 406).
kubectl --context platform-prod -n bnf logs deploy/bnf-demo-prod-broker --tail=3
kubectl --context platform-prod -n bnf exec deploy/bnf-demo-prod-broker -- node -e '
  const post=(u,a)=>fetch("http://localhost:8792/fetch",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({url:u,accept:a})}).then(r=>r.status);
  (async()=>{
    console.log("partner manifest (openapiproext, OAuth):", await post("https://openapiproext.bnf.fr/iiif/presentation/v3/ark:/12148/bpt6k1264641j/manifest.json","application/json"));
    console.log("partner ALTO (openapiproext, OAuth):", await post("https://openapiproext.bnf.fr/iiif/presentation/v3/ark:/12148/bpt6k1264641j/f10/alto.xml","application/xml"));
    console.log("ungated OAI (no auth):", await post("http://oai.bnf.fr/oai2/OAIHandler?verb=Identify","application/xml"));
  })();'
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
- **Broker is hard-pinned to ONE replica** (`replicas: 1` + `strategy: Recreate`
  in `broker-deployment.yaml`, intentionally NOT in values). Its rate buckets +
  OAuth token are in-memory per pod, and the 12/min manifest cap is per egress
  IP — a 2nd replica silently multiplies the caps → 429 storms. Never scale it;
  if HA is ever needed, move the buckets to shared state (Redis) first.
- **Broker cutover.** `BNF_BROKER_URL` is wired into both the app and worker
  configmaps; both fall back to their direct/relay path if `broker.enabled=false`.
  A broker outage during a deploy (Recreate → seconds of downtime) is absorbed by
  the clients (broker-transport errors are transient → retried with backoff).
