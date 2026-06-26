# BnF Corpus Research — Helm / ArgoCD Deployment

> **Current deployment (as of 2026-06-22):** the live demo runs as a **direct
> Helm release** (`bnf-demo-prod` in namespace `bnf` on `platform-prod`), NOT
> yet under ArgoCD. See [Direct Helm Release](#direct-helm-release-current) for
> the exact bring-up. The ArgoCD path below is the GitOps target once the chart
> is committed to `datastreaming-demos` `main`.

## Architecture

```
Internet
   │
   ▼
Istio Ingress Gateway       (bnf.demo.alien.club:443 — OWN gateway + cert)
   │
   ▼
VirtualService              (namespace: bnf, host bnf.demo.alien.club, path /)
   │
   ▼
Service  ClusterIP:80
   │
   ▼
Deployment  replicas=1      (stateless Next.js app, served at root — NO basePath)
   │
   ├─ Connects to:
   │   ├─ StatefulSet <release>-postgres:5432   (bundled Postgres, PVC-backed)
   │   ├─ <release>-worker:7777                 (ingest worker HTTP API — in-cluster only)
   │   ├─ bnf.mcp.alien.club                    (BnF MCP — corpus building)
   │   ├─ <datacluster MCP>                     (RAG — research)
   │   └─ api.anthropic.com                     (Claude agent loops)
   │
   ▼
Deployment  <release>-worker  replicas=1   ◄── THE DIFFERENCE FROM THE OTHER DEMOS
   │   (pg-boss consumer + HTTP submit API on :7777)
   │
   └─ Connects to:
      ├─ StatefulSet <release>-postgres:5432   (pg-boss queue — its own schema)
      ├─ <release>:80                          (posts HMAC-signed ingest-progress callbacks)
      ├─ gallica.bnf.fr                        (OCR / IIIF / manifests)
      ├─ api.scaleway.ai + Object Storage      (Holo2 vision + blob store)
      ├─ Google AI                             (Gemini vision)
      ├─ RunPod                                (bge-m3 embeddings)
      └─ api.alpha.alien.club/clusters/<id>/proxy  (data cluster register)
```

**The worker is what makes this chart different from `alien-agents` / `openaire` /
`publisher-demo`.** Those are app + Postgres. BnF adds a long-running **ingest
worker**: it pulls doc-ingest jobs from a pg-boss queue (in the bundled
Postgres), runs prepare → embed → register, and serves the HTTP submit API the
app calls. It is **internal only** — never fronted by Istio. pg-boss row-locks
make `worker.replicaCount > 1` safe (one shared queue, no double-processing). A
`wait-for-postgres` init-container gates the worker on the bundled Postgres so
it doesn't crash-loop on boot (the worker connects to pg-boss immediately and
has no in-process retry/wait of its own).

**Auth**: plain better-auth email/password. No Authentik / OAuth — and the
better-auth tables live in the same Prisma schema as the domain tables, so the
entrypoint's single `prisma migrate deploy` covers the whole schema (no separate
migrate-auth step).

**Gateway / certificate**: `bnf.demo.alien.club` is a dedicated subdomain served
at root `/`, so the chart provisions its **own** Istio Gateway + cert-manager
Certificate (no basePath, no URI rewrite). Switch to a shared gateway only if a
Gateway already serves the host — see "Shared-Gateway Mode" below.

---

## Naming Conventions

| Resource | Value |
|---|---|
| ArgoCD Application | `bnf-demo-prod` |
| Helm release name | `bnf-demo-prod` |
| Kubernetes namespace | `bnf` |
| All resources | prefixed `bnf-demo-prod-…` |
| App image repo | `rg.fr-par.scw.cloud/ns-data-streaming/bnf-demo` |
| Worker image repo | `rg.fr-par.scw.cloud/ns-data-streaming/bnf-demo-worker` |
| k8s context | `platform-prod` |

---

## Protected Secrets — DO NOT TOUCH

Annotated `helm.sh/resource-policy: keep`; they survive chart upgrades and are
generated once at first install. **Never delete or edit them directly.**

- `bnf-demo-prod-postgres` — Postgres password + `DATABASE_URL`.
- `bnf-demo-prod-app` — `BETTER_AUTH_SECRET` (rotating it invalidates every
  session) **and** `JOB_CALLBACK_SECRET` (the HMAC key the app signs
  ingest-callbacks with and hands the worker per job; rotating it breaks
  in-flight jobs).

Deleting either breaks the app irreversibly.

---

## Prerequisites (first install only)

- Kubernetes cluster with:
  - Istio (`ingressgateway` in `istio-system`).
  - DNS `bnf.demo.alien.club` → the Istio ingress LB.
  - cert-manager with a `letsencrypt` **ClusterIssuer**.
  - external-secrets with the `scaleway-secret-manager` ClusterSecretStore.
- A Scaleway Secret Manager secret named **`bnf-demo-prod`** holding every
  credential as a property (see "Scaleway Secret Manager" below).

### ⚠️ chat-sdk must be on npm before the app image builds

The app depends on `@alien/chat-sdk`, which is an **npm alias** for the published
`@alien_intelligence/chat-sdk` (see `bnf/package.json`). The app Dockerfile is a
plain `npm ci` — it pulls the SDK from the registry, NOT from the monorepo
`tooling/` tarball. So before building the app image, confirm:

```bash
npm view @alien_intelligence/chat-sdk@<version> version   # must exist on npm
```

The bnf `package.json` alias range (`^0.5.0`) and the published version must be
compatible, and `package-lock.json` must resolve to the registry tarball
(`registry.npmjs.org/@alien_intelligence/chat-sdk/...`), not a `file:` path.

---

## Scaleway Secret Manager

One secret (`bnf-demo-prod`) holds every credential as a property. The
ExternalSecrets project the subsets each workload needs.

| Property | Consumed by | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | app | Claude agent loops |
| `BNF_MCP_TOKEN` | app | BnF MCP (corpus building) |
| `CLUSTER_BEARER_TOKEN` | app + worker | data-cluster auth (RAG read + register write) |
| `LANGFUSE_SECRET_KEY` | app | optional — only if `config.langfusePublicKey` set |
| `SCW_S3_ACCESS_KEY` / `SCW_S3_SECRET_KEY` | worker | Scaleway Object Storage (blob) |
| `SCW_API_KEY` | worker | Scaleway GenAI (Holo2 vision) |
| `GOOGLE_AI_API_KEY` | worker | Gemini vision |
| `RUNPOD_API_KEY` | worker | bge-m3 embeddings |

Property names are configurable in `values.yaml` under `secrets.*Property`.

---

## Release Loop

### 1. Pre-flight checks

```bash
cd datastreaming-demos/bnf
npx tsc --noEmit     # 0 errors
npm run lint         # 0 errors
```

### 2. Version bump

Bump the same version in three places (keep them in sync):

```
1. bnf/package.json                              — "version"
2. bnf/helm/bnf-demo-chart/values.yaml           — image.tag
3. bnf/helm/bnf-demo-chart/values.yaml           — worker.image.tag
4. bnf/helm/bnf-demo-chart/Chart.yaml            — version + appVersion
```

### 3. Build and push BOTH images

Unlike the other demos there are **two** images. There is no basePath to bake in
— the app is served at root.

```bash
cd datastreaming-demos/bnf

# App image (plain context — chat-sdk comes from npm, see prerequisites)
docker build -t rg.fr-par.scw.cloud/ns-data-streaming/bnf-demo:<tag> .
docker push     rg.fr-par.scw.cloud/ns-data-streaming/bnf-demo:<tag>

# Worker image (V2 — context = ./worker-v2, its own Dockerfile; replaced V1)
docker build -f worker-v2/Dockerfile \
  -t rg.fr-par.scw.cloud/ns-data-streaming/bnf-demo-worker:<tag> worker-v2
docker push rg.fr-par.scw.cloud/ns-data-streaming/bnf-demo-worker:<tag>
```

### 4. Apply the ArgoCD application (first install only)

```bash
kubectl --context platform-prod apply -f helm/argocd-application.yaml
```

### 5. Push to git → ArgoCD auto-sync

```bash
git push origin main
```

`bnf-demo-prod` has `automated.selfHeal: true`. Force immediate pickup:

```bash
kubectl --context platform-prod \
  annotate application bnf-demo-prod -n argocd \
  argocd.argoproj.io/refresh=hard --overwrite
```

### 6. Verify startup

```bash
kubectl --context platform-prod logs -n bnf deploy/bnf-demo-prod --tail=30
```

Expected: Postgres wait → `prisma migrate deploy` → `▲ Next.js … ✓ Ready`.

```bash
kubectl --context platform-prod logs -n bnf deploy/bnf-demo-prod-worker --tail=30
```

Expected: `[worker-api] HTTP listening on :7777` and pg-boss starting.

---

## Direct Helm Release (current)

The live demo was brought up with plain Helm against `platform-prod` — no git
push, no ArgoCD. This is the fastest path and what's running today. Use the same
commands to redeploy after a chart or image change.

### 1. Create the Scaleway secret (first install only)

external-secrets reads one Scaleway Secret Manager secret named
`bnf-demo-prod`, whose value is a **JSON object** keyed by the property names in
`values.yaml` (`secrets.*Property`). Build it from a JSON file and push one
version:

```bash
# secret.json = {"ANTHROPIC_API_KEY":"…","BNF_MCP_TOKEN":"…","CLUSTER_BEARER_TOKEN":"…",
#   "LANGFUSE_SECRET_KEY":"…","SCW_S3_ACCESS_KEY":"…","SCW_S3_SECRET_KEY":"…",
#   "SCW_API_KEY":"…","GOOGLE_AI_API_KEY":"…","RUNPOD_API_KEY":"…"}

SECRET_ID=$(scw secret secret create name=bnf-demo-prod \
  project-id=77c152cc-4d27-4d9b-a449-143df07bcaad \
  description="BnF demo app+worker credentials" -o json | jq -r .id)

scw secret version create secret-id=$SECRET_ID data=@secret.json

rm -f secret.json   # never leave credentials on disk
```

To rotate a credential later: edit the JSON, `scw secret version create` a new
version (it becomes `latest`), then let the ExternalSecret refresh (`1h`) or
force it by deleting the synced k8s Secret so ESO recreates it.

### 2. Build + push both images

Same as steps 1–3 of the Release Loop above (build app + worker, push to the
Scaleway registry).

### 3. Install / upgrade

```bash
helm upgrade --install bnf-demo-prod helm/bnf-demo-chart \
  --kube-context platform-prod \
  --namespace bnf --create-namespace \
  --timeout 4m
```

Helm has cluster access, so the chart's `lookup`-based password/secret
preservation works correctly here (first install generates them; upgrades keep
them) — unlike ArgoCD, which needs the `ignoreDifferences` workaround.

### 4. Verify (live values)

```bash
kubectl --context platform-prod -n bnf get pods
curl -sS -o /dev/null -w "%{http_code}\n" https://bnf.demo.alien.club/   # 307 → /sign-in
curl -sS -o /dev/null -w "%{http_code}\n" https://bnf.demo.alien.club/api/auth/get-session  # 200
```

### Adopting into ArgoCD later

Commit the chart to `datastreaming-demos` `main`, push, then
`kubectl apply -f helm/argocd-application.yaml`. ArgoCD adopts the existing
resources; the `ignoreDifferences` block on the two generated Secrets keeps
their values from being rotated on the first sync. (A Helm release and an Argo
app managing the same resources can coexist, but pick one as the source of
truth to avoid churn.)

---

## Configuration Knobs (`values.yaml`)

| Key | Purpose | Default |
|---|---|---|
| `image.tag` / `worker.image.tag` | App / worker image tags | `0.1.0` |
| `config.publicUrl` | Public host (BETTER_AUTH_URL + APP_URL) | `https://bnf.demo.alien.club` |
| `config.clusterMode` | `real` → worker + datacluster RAG; `fake` → in-process fixtures | `real` |
| `config.bnfMcpUrl` | BnF MCP endpoint | `https://bnf.mcp.alien.club/mcp` |
| `config.dataclusterMcpUrl` | RAG MCP endpoint (real mode) | (alpha) |
| `config.langfusePublicKey` | Enables Langfuse tracing when set | `""` |
| `worker.enabled` | Deploy the ingest worker | `true` |
| `worker.replicaCount` | Worker replicas (pg-boss-safe to scale) | `1` |
| `worker.config.clusterId` | Data cluster ID (must match the RAG dataset region) | `""` |
| `worker.config.*` | Vision / embed / Gallica / reliability knobs | see values.yaml |
| `istio.hosts[].gateway` | `own` (provision gateway+cert) or `shared` | `own` |
| `postgres.persistence.size` | Postgres PVC size | `10Gi` |

**`config.clusterMode=fake`** disables the worker entirely (no worker Deployment,
Service, ConfigMap, or ExternalSecret rendered) — handy for a UI-only deploy.

---

## App ↔ Worker Wiring (the part that's easy to get wrong)

All set automatically by the chart in `real` mode:

- App → worker submit: `WORKER_RUNNER_URL = http://<release>-worker.<ns>.svc.cluster.local:7777`
- Worker → app callbacks: `WORKER_CALLBACK_BASE_URL = http://<release>.<ns>.svc.cluster.local`
  (in-cluster, no Istio hairpin).
- The worker rejects callbacks whose host doesn't match its `APP_BASE_URL`.
  The chart derives **both** `WORKER_CALLBACK_BASE_URL` and `APP_BASE_URL` from
  the same `bnf-demo.appInternalUrl` helper, so they always match. If you change
  one by hand, change the other.

---

## ArgoCD Sync Waves

| Wave | Resources |
|---|---|
| `-2` | ConfigMaps, ExternalSecrets, generated Secrets (app + postgres) |
| `0` | Postgres StatefulSet + Service, app + worker Deployments + Services, Gateway, VirtualService, Certificate |

`argocd-application.yaml` adds `ignoreDifferences` + `RespectIgnoreDifferences`
on the two generated Secrets so syncs don't rotate the kept passwords/secrets.

---

## Troubleshooting

### App pod `CrashLoopBackOff`
```bash
kubectl --context platform-prod logs -n bnf deploy/bnf-demo-prod
```
Entrypoint waits ~2 min for Postgres, then runs `prisma migrate deploy`. Most
startup failures are a missing env var (lib/env.ts throws by name) or a migration
issue.

### App image build fails on `npm ci`
`@alien_intelligence/chat-sdk@<range>` isn't on npm, or `package-lock.json` still
resolves the SDK to a `file:` path. See "chat-sdk must be on npm" above.

### Ingestion never progresses / chat says "le traitement continue"
Check the worker:
```bash
kubectl --context platform-prod logs -n bnf deploy/bnf-demo-prod-worker --tail=80 \
  | grep -iE "error|callback|expire|throttle"
```
Common causes: a missing worker credential (S3 / RunPod / SCW), or `clusterId`
not matching the RAG dataset region. A long OCR book legitimately takes tens of
minutes at Gallica's 5 req/min — that's the `INGEST_JOB_EXPIRE_SECONDS` ceiling,
not a hang.

### Worker init-container stuck `Init:0/1`, logs `pg_isready ... - no attempt`
`no attempt` (PQPING_NO_ATTEMPT) means libpq bailed *before* connecting because
`getpwuid()` failed: the pod runs as `securityContext.runAsUser: 1000`, which
has no entry in the `postgres` image's `/etc/passwd`. The init-container passes
`-U <postgres.username>` to skip that lookup — if you change the image or
securityContext and this resurfaces, keep the explicit `-U`.

### Ingest callbacks rejected (worker logs `host '...' does not match APP_BASE_URL`)
`WORKER_CALLBACK_BASE_URL` (app) and `APP_BASE_URL` (worker) drifted apart. Both
should equal the app's in-cluster Service URL. Re-sync; don't hand-edit one.

### Cert never issues / TLS handshake fails
```bash
kubectl --context platform-prod get certificate -n istio-system bnf-demo-prod-tls
kubectl --context platform-prod describe certificate -n istio-system bnf-demo-prod-tls
```
Check DNS `bnf.demo.alien.club` resolves to the ingress LB (ACME HTTP-01 needs
port 80 reachable — the chart's Gateway serves `:80` with `httpsRedirect: false`
for the challenge) and the `letsencrypt` ClusterIssuer exists.

### Postgres pod `Pending`
PVC unbound — storage class mismatch. Leave
`postgres.persistence.storageClassName` unset to use the cluster default
(`sbs-default` on Scaleway).

> **Never** run `kubectl delete application bnf-demo-prod` on `platform-prod` —
> it cascades and deletes the Postgres StatefulSet + PVC. See the platform-wide
> CLAUDE.md ArgoCD rules.

---

## Shared-Gateway Mode (alternative)

If a Gateway already serves the host, attach to it instead of provisioning one:

```yaml
istio:
  hosts:
    - host: bnf.demo.alien.club
      path: /
      gateway: shared
  sharedGatewayName: <existing-gateway-name>   # kubectl get vs -A -o wide | grep <host>
  gateway:
    create: false
  certificate:
    enabled: false
```

Serving under a path prefix (e.g. `demo.alien.club/bnf`) is **not** supported
out of the box — the app has no `basePath` wiring. It would require baking
`NEXT_PUBLIC_BASE_PATH` into the client bundle at build time and an Istio
rewrite. The dedicated subdomain avoids all of that.

---

## Data Persistence Notes

- Bundled Postgres has **no replication and no backup** — fine for a demo, not
  for real production data. Both the app schema and the worker's pg-boss queue
  live in it.
- The StatefulSet PVC + generated Secrets are `helm.sh/resource-policy: keep` —
  uninstalling the chart leaves them in place. To fully wipe state, delete the
  PVC and Secrets manually after `helm uninstall`.
