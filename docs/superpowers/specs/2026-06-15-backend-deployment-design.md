# ultra-tool-kit backend — prod deployment design

**Date:** 2026-06-15
**Branch:** `feature/ai-enhancement` (created in every repo touched)
**Status:** approved design, pre-implementation

## 1. Problem & context

The `feature/ai-enhancement` branch adds a `backend/` service to ultra-tool-kit:
a small, **stateless Hono (Node, ESM, run via `tsx`) AI-assistance API**. It runs
only on localhost today (`tsx src/index.ts`, binds `127.0.0.1:8787`). Goal: deploy
it to the Ultra **prod** k8s cluster via the existing ArgoCD + Helm pattern, and
wire the existing Cloudflare-Pages frontend to call it.

### Findings from the deployment check

- **Frontend is ALREADY on Cloudflare Pages.** `~/ultra/terraform/cloudflare/pages/main.tf`
  defines `module "ultra-toolkit"` (repo `ultra-tool-kit`, branch `gh-pages`,
  custom domain `toolkit.ultra.io`). GitHub Actions (`gh-page.yml`) builds `dist/`
  and pushes it to `gh-pages`; CF Pages serves it (no `build_command` set → it
  serves prebuilt files, so Vite env vars must be injected at the **GitHub Actions
  build**, not in CF Pages). The frontend does **not** move; it stays a static SPA
  on CF Pages.
- **Nothing for the backend exists** in `helm-charts` (branch `master`),
  `ultra-apps`, or terraform. No chart, no ArgoCD app, no image, no DNS record.
- **The backend has no database** (`backend/CLAUDE.md`, the current source of
  truth). Catalog = committed JSON loaded at boot; usage = append-only
  `logs/usage.jsonl`; rate-limit = in-process token buckets. The
  `backend/docs/0x-*.md` files mentioning Fly.io / Neon Postgres / pgvector are
  flagged stale and are NOT followed. The backend is **not** a Cloudflare Worker
  candidate (filesystem-stateful by design) — it stays in k8s.
- **No Dockerfile exists**; `helm-charts` holds only charts. An image must be
  built and pushed to `europe-west1-docker.pkg.dev/ultra-registry/docker/...`.
- **No Cloudflare Tunnel / Worker / Pages-Function pattern exists** anywhere in
  terraform. The proven way Ultra exposes a backend is **nginx ingress +
  cert-manager TLS + a proxied Cloudflare DNS record** (e.g. `ultra-claim` →
  `claimrequest.ultra.io`). We follow that, not a net-new tunnel.
- **`ultra-claim` is the template** (Node/TS backend, ingress, `ultra.io` host):
  - Dockerfile: multi-stage `node:lts-alpine`, build stage installs + (for them)
    compiles TS, runtime stage copies `node_modules` + output. `EXPOSE`, plain
    `node` entrypoint, default base-image user.
  - Image CI `.github/workflows/docker-publish.yml`: trigger **`on: release:
    [created]`**; GCP auth via **Workload Identity** (`secrets.REG_WIF`,
    `service_account: wif-gar@ultra-registry.iam.gserviceaccount.com`); build with
    `redhat-actions/buildah-build@v2`; push with `redhat-actions/push-to-registry@v2`
    to `europe-west1-docker.pkg.dev`; tags `latest` + `${{ github.sha }}` +
    `${{ github.event.release.tag_name }}`.
  - Health: `GET /health` returns `true`; chart probes hit it.
  - Helm chart lives in the **separate helm-charts repo**, not the app repo.
- Our backend exposes only `/api/ai-chat`, `/api/ai-usage`, `/api/ai-quota` —
  **no `/health`**. `BIND_HOST`/`BIND_PORT` are env-driven (`src/index.ts:218-219`),
  so the container sets `BIND_HOST=0.0.0.0` via values — no code change → no
  `0.0.0.0`-in-code CI-grep violation (backend/CLAUDE.md hard-rule 6).
- The frontend resolves the backend host in ONE place: `getBaseUrl()` in
  `src/utilities/aiClient.ts:100` (default `http://localhost:8787`, override via
  build env `VITE_AI_BACKEND_URL`). All three AI calls go through it. The browser
  calls the backend **directly** (no proxy/BFF).

### Decisions (locked with the user)

| Decision | Choice |
|---|---|
| Target environment | **Prod only** |
| Chart structure | **Standalone** `ultra-tool-kit-backend` chart in helm-charts; frontend stays on CF Pages |
| Resources | **Lean** — requests `128Mi`/`100m`, limits `256Mi`/`500m` |
| Backend exposure | **nginx ingress + cert-manager TLS + proxied Cloudflare DNS**, mirroring `ultra-claim`. Host: `ai-toolkit.ultra.io` |
| Frontend ↔ backend | **Cross-origin direct call.** Backend `ALLOWED_ORIGINS=https://toolkit.ultra.io`; frontend `VITE_AI_BACKEND_URL=https://ai-toolkit.ultra.io` |
| `VITE_AI_BACKEND_URL` delivery | **Set in the GitHub Actions build** (`gh-page.yml`) — least change; CF Pages serves prebuilt files |
| Runtime URL override | **Yes** — user-settable backend URL in the ChatDrawer (localStorage), overrides the baked default |
| API key delivery | **Reference an existing k8s Secret by name** (`secretKeyRef`), optional inline escape hatch; raw key never committed |
| Image CI | **Mirror `ultra-claim`'s `docker-publish.yml`** (release-triggered, WIF/`REG_WIF` auth) — functional, needs `REG_WIF` on the repo |
| Health probe | **Add `GET /health` to the backend**; chart uses `httpGet` probes |
| Branch name | **`feature/ai-enhancement`** in helm-charts, ultra-apps, and terraform |

### Cross-origin note

Page origin `https://toolkit.ultra.io` ≠ API origin `https://ai-toolkit.ultra.io`,
so chat calls are cross-origin: the browser sends a CORS preflight, answered by
Hono's `cors({ origin: cfg.allowedOrigins })` (`src/index.ts:109`). Therefore
`ALLOWED_ORIGINS` MUST include `https://toolkit.ultra.io`. (A same-origin
CF Pages-Function proxy to drop CORS is a possible later refinement, explicitly
out of scope here.)

## 2. Deliverable A — backend repo changes (`ultra-tool-kit`, branch `feature/ai-enhancement`)

### A1. `backend/Dockerfile` + `backend/.dockerignore`
- Multi-stage on `node:lts-alpine` (current LTS tag verified at build).
  - **deps stage:** copy `package.json` + `package-lock.json`, `npm ci`.
  - **runtime stage:** copy `node_modules`, `src/`, `catalog/`, `package.json`;
    create `logs/`; run as non-root.
- No `tsc`/`dist` step — the app runs via `tsx` (`start` = `tsx src/index.ts`), so
  `tsx` must remain installed. `CMD ["npm","start"]`.
- `ENV NODE_OPTIONS=--max-old-space-size=192` to stay under the lean 256Mi limit.
- `EXPOSE 8787`.
- `web-tree-sitter`/`tree-sitter-cpp` are extractor-only (offline CLI); the runtime
  only loads catalog JSON → small image.
- `.dockerignore`: `node_modules`, `logs`, `.env*`, `test`, `docs`, `*.md`.

### A2. `backend/src` — add `GET /health`
- A tiny unauthenticated route returning `200` (`{ ok: true }`), mounted **outside**
  the `/api/*` attestation/rate-limit/quota chain so probes never consume quota or
  hit the LLM. Lets the chart use `httpGet` probes like every other Ultra app.

### A3. `.github/workflows/docker-publish.yml` (new) — backend image
- Mirror `ultra-claim`'s workflow verbatim, changing only `image:` →
  `ultra-registry/docker/ultra-tool-kit-backend`, `context: ./backend`,
  `containerfiles: ./backend/Dockerfile`.
- Trigger `on: release: types: [created]`; WIF auth via `secrets.REG_WIF`; tags
  `latest ${{ github.sha }} ${{ github.event.release.tag_name }}`.
- Functional once `REG_WIF` is configured for the repo (same secret ultra-claim uses).

### A4. `.github/workflows/gh-page.yml` — inject the backend URL at build
- Add `env: VITE_AI_BACKEND_URL: ${{ vars.VITE_AI_BACKEND_URL }}` (a repo
  variable, e.g. `https://ai-toolkit.ultra.io`) to the `npm run build` step so the
  CF-Pages-served bundle defaults to the prod backend. Runtime UI field still wins.

### A5. `src/utilities/aiClient.ts` — runtime backend-URL override
- `localStorage` key `aiBackendUrl`. `getBaseUrl()` order: **stored override →
  `VITE_AI_BACKEND_URL` → `http://localhost:8787`**.
- Add `getStoredBaseUrl()`, `setBaseUrl(url)`, `clearBaseUrl()`. Optional reachability
  check pings `GET /api/ai-usage` (cheap 200; doubles as a CORS sanity check).

### A6. `src/components/ai/ChatDrawer.vue` — settings field
- Gear button in the header → inline settings section with the backend-URL input
  (placeholder `http://localhost:8787`), showing the active URL + source, a
  validate/save action (mirrors `Endpoint.vue`'s custom-endpoint UX), and "reset to
  default". Takes effect on the next call; no rebuild.

## 3. Deliverable B — Helm chart (`helm-charts`, new branch `feature/ai-enhancement`)

Path `charts/ultra-tool-kit-backend/`, modeled on the faucet `backend` subchart,
lean + standalone, **ingress enabled** (mirrors `ultra-claim`).

```
charts/ultra-tool-kit-backend/
  Chart.yaml                 # name: ultra-tool-kit-backend, version 0.1.0, appVersion 0.1.0
  values.yaml
  templates/
    _helpers.tpl
    deployment.yaml
    service.yaml
    configmap.yaml           # non-secret env
    secret.yaml              # only when secret.create=true (escape hatch)
    serviceaccount.yaml
    ingress.yaml             # enabled
    pdb.yaml
    NOTES.txt
```

### `values.yaml` (key fields)

```yaml
replicaCount: 1
image:
  repository: europe-west1-docker.pkg.dev/ultra-registry/docker/ultra-tool-kit-backend
  pullPolicy: IfNotPresent
  tag: ""                                  # set per-env in ultra-apps
service:
  type: ClusterIP
  port: 8787
ingress:
  enabled: true
  className: "nginx"
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod-dns
    nginx.ingress.kubernetes.io/enable-cors: "true"
    nginx.ingress.kubernetes.io/cors-allow-origin: https://toolkit.ultra.io
  hosts:
    - host: ai-toolkit.ultra.io
      paths: [{ path: /, pathType: ImplementationSpecific }]
  tls:
    - secretName: ai-toolkit-prod-tls
      hosts: [ai-toolkit.ultra.io]
resources:
  requests: { memory: "128Mi", cpu: "100m" }
  limits:   { memory: "256Mi", cpu: "500m" }
autoscaling: { enabled: false }
pdb: { maxUnavailable: 1 }
serviceAccount: { create: true, name: "" }
nodeSelector: { role: application }
config:                                    # -> ConfigMap (non-secret env)
  BIND_HOST: "0.0.0.0"
  BIND_PORT: "8787"
  LLM_PROVIDER: "anthropic"
  ANTHROPIC_CHAT_MODEL: "claude-haiku-4-5-20251001"
  ALLOWED_ORIGINS: "https://toolkit.ultra.io"
  # ATTESTATION_CHAIN_ID, ALLOWED_CHAIN_HOSTS, BALANCE_THRESHOLD_UOS, QUOTA_* optional
secret:                                    # ANTHROPIC_API_KEY delivery
  create: false                            # true => template secret.yaml from anthropicApiKey
  existingSecret: "ultra-tool-kit-backend-secrets"
  apiKeyKey: "ANTHROPIC_API_KEY"
  anthropicApiKey: ""                      # ONLY used when create=true; filling it commits the key
```

### Deployment behavior
- Container port `8787`; `envFrom` the ConfigMap; `ANTHROPIC_API_KEY` via
  `secretKeyRef` → `{{ .Values.secret.existingSecret }}`/`{{ .Values.secret.apiKeyKey }}`
  (or the chart-created secret when `secret.create=true`).
- **Liveness & readiness:** `httpGet` `/health` on `8787` (added in A2), with a small
  `initialDelaySeconds` for boot-time catalog load.
- `nodeSelector.role: application`; PDB `maxUnavailable: 1`.

### Secret rotation / switching (single control point)
- **Rotate:** `kubectl -n prod-env create secret generic ultra-tool-kit-backend-secrets --from-literal=ANTHROPIC_API_KEY=... --dry-run=client -o yaml | kubectl apply -f -`
- **Switch secret:** change `secret.existingSecret` in ultra-apps prod values — no key value in git.

## 4. Deliverable C — ArgoCD app (`ultra-apps`, new branch `feature/ai-enhancement`)

Path `argocd-apps/ultra/prod-env/ultra-tool-kit-backend/`, mirroring `ultra-claim`.

- `ultra-tool-kit-backend-prod-app.yaml`: `project: ultra-prod-env-apps`; source =
  helm-charts `path: charts/ultra-tool-kit-backend`, **`targetRevision: feature/ai-enhancement`**
  (branch — no chart tag yet; switch to `ultra-tool-kit-backend-0.1.0` once tagged);
  values from ultra-apps `HEAD`. Destination `ultra-prod`/`prod-env`; `ultra-claim`'s
  sync policy (selfHeal, CreateNamespace, retry).
- `ultra-tool-kit-backend-prod-values.yaml`: `image.tag` (placeholder), ingress host
  `ai-toolkit.ultra.io` + TLS secret, `ALLOWED_ORIGINS=https://toolkit.ultra.io`,
  `secret.existingSecret` name. No raw secrets.

## 5. Deliverable D — DNS (`terraform`, new branch `feature/ai-enhancement`)

- Add a **proxied Cloudflare DNS record** for `ai-toolkit.ultra.io` pointing at the
  prod nginx-ingress load balancer, mirroring how `claimrequest.ultra.io` is wired.
- **To verify at implementation time:** whether Ultra uses `external-dns` (auto-creates
  the record from the ingress) or a manual `cloudflare_record` in
  `~/ultra/terraform/cloudflare/dns/`. If external-dns is in play, this deliverable may
  reduce to confirming the annotation; otherwise add the explicit record. (`VITE_AI_BACKEND_URL`
  is NOT set here — it's in the GitHub Actions build per the decision.)

## 6. Out of scope (YAGNI)
- Moving the frontend off CF Pages / into k8s (already on CF Pages, stays).
- Postgres / pgvector / Fly.io (backend is stateless, no DB).
- Cloudflare Tunnel / Worker / Pages-Function proxy (net-new; ingress+CF-DNS is proven).
- Running the backend as a CF Worker (filesystem-stateful design).
- Autoscaling / multi-replica (lean single replica; usage JSONL is per-pod ephemeral —
  acceptable for telemetry).
- Staging env (prod-only per decision).

## 7. Suggested implementation phases (for the plan)
1. **Backend deployability** — Dockerfile + `.dockerignore`, `GET /health`,
   `docker-publish.yml`. Output: a buildable, pushable image with a health route.
2. **k8s deploy** — Helm chart in helm-charts + ArgoCD app/values in ultra-apps
   (ingress, secretKeyRef). Output: backend reconciles in prod behind `ai-toolkit.ultra.io`.
3. **DNS** — terraform CF DNS record (or external-dns confirmation).
4. **Frontend wiring** — `VITE_AI_BACKEND_URL` in `gh-page.yml`, runtime override in
   `aiClient.ts`, ChatDrawer settings field. Output: deployed SPA talks to the backend.

## 8. Verification
- `helm template charts/ultra-tool-kit-backend -f <prod-values>` renders Deployment +
  Service + ConfigMap (+ optional Secret) + Ingress with lean resources, `secretKeyRef`,
  and `httpGet /health` probes; no errors.
- `docker build -f backend/Dockerfile backend/` succeeds; container boots, logs
  `backend listening`, and `GET /health` returns 200 on `0.0.0.0:8787`.
- `curl https://ai-toolkit.ultra.io/health` returns 200 once deployed + DNS live;
  an OPTIONS preflight from `https://toolkit.ultra.io` is allowed.
- ArgoCD app + values + terraform validate (lint / `kubectl apply --dry-run` / `terraform plan`).
- Branches `feature/ai-enhancement` exist in helm-charts, ultra-apps, terraform.
