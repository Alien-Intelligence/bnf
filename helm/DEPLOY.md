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
make `worker.replicaCount > 1` safe (one shared queue, no double-processing);
a replica that is up but broken makes the app's OCR sync see a partly failing
worker — it quarantines nobody for it but slows down (see "OCR quality
backfill"), so fix or remove such a replica. A
`wait-for-postgres` init-container gates the worker on the bundled Postgres so
it doesn't crash-loop on boot (the worker connects to pg-boss immediately and
has no in-process retry/wait of its own).

**Auth**: better-auth, email/password plus Alien Auth (Authentik) SSO through
the genericOAuth plugin when `config.authentikBaseUrl` and the shared
`authentik-prod` credentials are present (see `values.yaml`). The better-auth
tables live in the same Prisma schema as the domain tables, so the entrypoint's
single `prisma migrate deploy` covers the whole schema (no separate migrate-auth
step). Each `session` row records how it was opened (`login_method`), which
sign-out reads to decide whether Authentik's session must end too — see
"Sign-out and the Authentik session" below.

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

### Sign-out and the Authentik session (ops prerequisites)

`POST /api/sign-out` always deletes the app session. For a session opened
through Authentik it also sends the browser to the application's OIDC
`end_session_endpoint` (read from
`<authentikBaseUrl>/application/o/<authentikAppSlug>/.well-known/openid-configuration`,
never guessed), with `id_token_hint`, `client_id` and
`post_logout_redirect_uri = <publicUrl>/sign-in?signedOut=done` (or
`/en/sign-in?signedOut=done`). No new value or secret: it reuses
`config.authentikBaseUrl`, `config.authentikAppSlug`, the shared client id and
`config.publicUrl`. If discovery is unreachable (5 s bound), the app session
still ends and the sign-in page says the Alien session could not be closed.

Two Authentik-side changes are needed for the SSO half to do what users expect.
They are **not** made from this repo:

1. **Required — a User Logout stage.** Authentik's
   `default-provider-invalidation-flow` has no User Logout stage, so
   end-session closes the provider session only and the Authentik session
   survives: « Se connecter avec Alien » signs the user straight back in.
   Create a dedicated invalidation flow containing a User Logout stage and bind
   it to the `datastreaming` provider. Do not edit the default flow, which every
   provider shares. The `datastreaming` application is shared with the
   alien-agents demo, so its logout changes the same way.
2. **For the redirect back to BnF — Authentik ≥ 2026.5.3.** Prod pins chart
   `2026.2.2` (`k8s-charts/helm/cluster-infrastructure/templates/authentik.yaml`).
   `post_logout_redirect_uri` is honoured from 2026.5 (2026.5.3 fixes a matching
   regression), and must be registered on the provider as a **Logout**-type
   redirect URI, e.g. the regex
   `^https://bnf\.demo\.alien\.club/(en/)?sign-in\?signedOut=done$`.
   Avoid 2026.8.0+ until goauthentik/authentik#26561 (blank 200 at
   end-session) is fixed. Until the upgrade, the browser stops on Authentik's
   own "logged out" page.

These facts come from Authentik's docs and issue tracker, not from a probe of
`auth.alien.club`; the first SSO sign-out after deploy confirms them:

```bash
# The discovery document must carry end_session_endpoint:
curl -sS https://auth.alien.club/application/o/datastreaming/.well-known/openid-configuration \
  | jq -r .end_session_endpoint
```

Then, in a browser: sign in with « Se connecter avec Alien », sign out, and
check that the address bar passes through `…/end-session/?id_token_hint=…`,
and that signing in again asks for credentials (it will not until step 1).

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
| `worker.config.ocrBackfillEnabled` | Build missing OCR-quality artifacts (BnF spend; see below) | `"true"` |
| `worker.config.ocrBackfillConcurrency` | In-flight backfill documents (positive integer) | `"2"` |
| `worker.config.ocrBackfillRetryFailedAfterMs` | Base backoff before a transiently failed backfill build is retried (doubles per attempt, 5 attempts max) | `"86400000"` (24 h) |
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

## OCR quality backfill

The low-OCR disclaimer (feedback 2026-09-29 #7) reads each folio's OCR quality
from the app tables `document_ocr` / `document_folio`, which mirror the worker's
per-ARK S3 artifact `v2/ocr-quality/<slug>.json`. New ingests write the artifact
themselves. Documents indexed **before** the release have none and are
backfilled automatically — no manual step:

- **What drives it:** the app's `[ocr-sync]` sweep (boot + every 3 min, at most
  10 × 100 ARKs per cycle, cited documents first) calls the worker's
  `POST /ocr-quality/sync`. Each missing artifact is queued once on the worker's
  `ocr-quality-backfill` stage, which answers `building` until it is done.
- **How to watch it:**
  - app logs: `[ocr-sync] cycle (<trigger>): available=…, building=…, unavailable=…, incompatible=…, rejected=…, outage=…, struck=…, stop=…`
    — `trigger` is `boot`, `sweep` or `commit`; `stop` says why the cycle ended
    (`done` = nothing left to ask; `budget` / `deadline` = it will resume next
    sweep; `worker_unavailable` = no request of the cycle was answered,
    `exchange_paused` = the worker's answers break the contract as a whole,
    `coalesced` = another drain ran). Cycles ending `done` with `building=0`
    mean converged;
  - worker pod: `npm run status` prints `ocrBackfill: {queued, done, failed}`;
  - Postgres: `SELECT status, reason, count(*) FROM document_ocr GROUP BY 1, 2;`
- **App-side sync state (persisted):** what is due lives in `document_ocr`,
  never in memory: a row is asked again at `next_check_at` (building: next
  sweep; unavailable and incompatible: 24 h). A re-ingest commit sets
  `resync_requested_at` in its own transaction, so a re-OCR'd document is
  re-pulled even after a restart, with a fresh rejection, outage and strike
  budget. Corpora are drained in turn, each cycle resuming after the last
  corpus served; corpora with resync requests go first, but while other
  corpora wait at most 5 of them (half the cycle's 10 batches) are started
  per cycle, the next cycle resuming after the last one (a `building` row's
  request does not count).
- **Failures are told apart by evidence, nothing else:**
  - *Transport* (no answer, a timeout, a 5xx, a 404 from an old worker, a body
    that is not JSON) says nothing about any document and never counts against
    one by itself. A batch that fails ends that corpus's turn and paces it (3
    min doubling to 1 h); other corpora are still asked. Each of its documents
    gets a `pending` row ("not yet") and its `outage_count` goes up. A
    document whose batch failed twice (`outage_count` ≥ 2) is asked ALONE —
    at most 10 such requests per cycle, controls included — while the rest of
    its corpus goes on in batches without it.
  - A document asked alone gets an **outage strike** only inside a bracket of
    evidence, in one cycle: an answered request → it fails → two **control**
    documents answered back to back → it fails again. Controls rotate among
    the 10 most recently synced `available` documents that have no outage on
    record; a control that fails is recorded like any document's lone failure
    and ends the isolation for that cycle. Anything short of the bracket only
    backs the document off. After 5 strikes it is `quarantined` with `reason
    = worker_fails_alone: …` — never an `available` document, which keeps its
    quality and only backs off. Strikes are logged at **warn**.
  - Measured on the real tables, production limits, 3-min cadence
    (tests/models/documents/ocr-sync-pg.test.ts): 48 h of a down worker → 0
    strikes, 152 requests over 960 cycles, all served 13 cycles after it
    returns; a poison document among 3 → quarantined in 69 min, the others
    served; a poison at position 0 of a 100-document batch → 99 served and the
    poison quarantined in 69 min; a lone broken artifact → quarantined in 48
    min, nothing paused. A **partly failing worker** strikes no innocent into
    quarantine: over 6 h on 1 200 documents, a worker answering every other
    request, a worker dying after the first request of each cycle, and two
    replicas of which one always fails (50 % random, 8 seeds) → 0 quarantines,
    0 to 6 warn-level strike lines per run. It is slow, though: the 50 % case
    served 410–1 139 of the 1 200 in those 6 h. A broken worker replica is
    therefore worth fixing or removing even though it quarantines nothing.
  - *Contract*, decided per document by the artifact's own version `v`. An
    artifact of another `v` than the app reads → `incompatible` (`reason =
    artifact_version: worker artifact v2, this app reads v1`, the expected
    version stored beside it): a deploy mismatch, nobody blamed, shown as
    "waiting for a service update", asked again in 24 h — and at once when an
    app reading another version boots — logged once per cycle at error level
    with both versions. An artifact of the expected `v` that fails its schema
    → that document alone is rejected: it backs off (3 min doubling, capped at
    24 h) and after 5 rejections is `quarantined` with `reason =
    sync_rejected: …`; the sync goes on. A 400 naming one document, or
    documents left out of an otherwise answered batch, are rejected the same
    way and the rest asked again. Only an answer that is not a sync answer at
    all (401/403/413, an envelope that does not parse, an answer to nothing
    asked) pauses the whole sync (3 min doubling to 1 h); the first answer
    resumes it.
  - An `available` document keeps its stored quality through `building` and
    `unavailable` answers (what a worker deployed first answers while it
    rebuilds its artifacts after a version bump); only a new `available`
    answer replaces it, and an `incompatible` one hides it.
  - Every failure write is a compare-and-set checked against the time its
    question was asked: an answer or failure recorded since wins (nothing is
    written), several app replicas or a rolling update record one failure
    once, and a resync requested since keeps the document due.
  - **Quarantine is never terminal:** a quarantined document is asked again
    after 24 h, doubling to a 7-day cap, at once after a re-ingest's resync,
    and any answer restores it fully — so a mistaken quarantine heals itself.
    Only `unavailable` (BnF does not provide the quality) is shown as "may
    never be available". To list problems:
    `SELECT ark, status, reason, sync_attempts, outage_strikes, next_check_at FROM document_ocr WHERE status IN ('quarantined', 'unavailable', 'incompatible') ORDER BY checked_at DESC;`
- **The artifact version rule (any contract change bumps `v`):** a change to
  what the worker writes in `ocr-quality/<slug>.json` — a field, a type, a
  meaning or scale (e.g. `ocrRate` as a percentage), one lane's folio shape —
  MUST bump `OCR_QUALITY_ARTIFACT_VERSION` in worker-v2 `src/domain/types.ts`
  AND in the app's `lib/cluster/ocr-quality.ts`. The app enforces it: a test
  (`lib/cluster/ocr-quality-contract.test.ts`) fingerprints the artifact
  schema per version, so a schema change without a bump fails CI. Unbumped,
  correct artifacts are rejected as broken, or still parse and are read with
  the old meaning. Bumped, deploy the worker first: it treats its stored
  artifacts of the old version as corrupt and rebuilds them through the
  backfill (BnF cost as below) — the app keeps showing their stored quality
  while it does, then "waiting for a service update" for each rebuilt one
  until the matching app is deployed, whose boot re-asks those documents at
  once.
- **BnF cost:** one Presentation-API (ALTO) call per indexed **text** folio,
  once — the `alto` cache holds extracted text, not XML, so the word confidences
  must be re-fetched. Vision and Mistral documents cost nothing. The calls go
  through the broker and share the worker's fetch rate gate FIFO with live
  ingests; check the broker's `/calls.csv` for a 429 increase on live runs.
- **Retries:** a build that fails transiently (BnF 5xx, a fetch-gate wait over
  120 s) is retried with a backoff of `ocrBackfillRetryFailedAfterMs` doubling
  per attempt, at most 5 attempts; a permanent failure (no metadata, no pages
  artifact, unclassifiable, a permanent BnF error) is never retried and is
  reported `unavailable` with its reason, with the folio when one folio
  caused it (`build_failed: f12: …`). A delivery stops at its 1 h ceiling (the
  worker aborts its gate waits and folio walk; an ALTO fetch already sent ends
  within its 135 s timeout and its answer is discarded — nothing is written
  after the ceiling) and is redelivered after 150 s. A build whose deliveries
  never report back is re-queued 1 h 30 after its last delivery STARTED,
  as one attempt — a build still waiting in the backlog is never counted as
  expired; after 5 attempts it is `build_expired`. An artifact that keeps
  vanishing after being built ends as `artifact_lost` the same way. The base
  backoff `ocrBackfillRetryFailedAfterMs` must be at least 60000 ms.
- **First deploy of the claim token:** backfill messages queued before it
  carry no `generation`; they are read as generation 0 — the value every
  pre-existing row gets from the new column's default — so they still build
  the row they were sent for, at no attempt cost. A message whose row was
  re-opened since (generation ≥ 1) builds nothing and completes.
- **How to speed it up:** raise `worker.config.ocrBackfillConcurrency` off-hours
  (default 2 ≈ 60–120 folios/min).
- **How to stop the spend without a rollback:** set
  `worker.config.ocrBackfillEnabled: "false"`. The stage is not registered and
  missing ARKs answer `unavailable: backfill_disabled` (a stored failure keeps
  its own reason; a corrupt artifact answers `artifact_corrupt`); the app
  rechecks them after 24 h. Existing artifacts are still served.
- **`BNF_BROKER_URL` is required by the worker:** it refuses to boot without a
  valid http(s) URL (never a per-document failure later). The chart always sets
  it — its own broker's service URL, or `worker.config.bnfBrokerUrl` when
  `broker.enabled` is false (the render fails if that is empty).
- **All knobs are validated at startup:** a malformed `OCR_BACKFILL_*` value
  stops the worker with the variable's name rather than running on a guess.
- **Rollout order:** the worker must be at least as new as the app (an old worker
  answers 404 on `/ocr-quality/sync`; the app logs the failed batch and retries
  every sweep). Roll the worker **between ingest runs**: a text document whose
  folios were fetched by the old worker and assembled by the new one has no ALTO
  quality sidecars and fails at once with `ocr_quality_missing_sidecar: …`
  (a terminal failure, not retried). Retrying the failed documents re-fetches
  them with sidecars.

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
minutes at BnF's rate cap — that is not a hang.

A run that is genuinely stuck heals itself: the worker sweeps every unfinished
run every `RECONCILER_INTERVAL_MS` (60s), re-drives docs whose queue job vanished
(a pg-boss expiration, a pod killed mid-delivery), and re-fires a terminal
callback whose POST failed. Watch it:
```bash
kubectl --context platform-prod logs -n bnf deploy/bnf-demo-prod-worker --tail=200 \
  | grep -E "reconciler_(requeued|doc_failed|run_checked|sweep)"
```
A quiet sweep logs nothing. `reconciler_doc_failed` with
`stranded_after_requeues` means one doc was re-driven `RECONCILER_MAX_REQUEUES`
times without progress and was failed so the run could finish — look at that
doc's ARK, not at the sweep. To sweep ONE run immediately instead of waiting for
the next tick: `node --import tsx src/requeue-stranded.ts <runId>`.

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
