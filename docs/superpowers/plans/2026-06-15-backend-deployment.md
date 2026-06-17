# ultra-tool-kit Backend Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the stateless Hono AI backend to Ultra prod k8s behind `ai-toolkit.ultra.io`, and wire the existing Cloudflare-Pages frontend (`toolkit.ultra.io`) to call it cross-origin.

**Architecture:** Mirror the proven `ultra-claim` deployment: a multi-stage Docker image built by a release-triggered GitHub Actions workflow, shipped to prod via a lean standalone Helm chart (helm-charts repo) + an ArgoCD Application (ultra-apps repo), exposed through nginx ingress + cert-manager + a proxied Cloudflare DNS record (terraform repo). The browser calls the backend directly; `VITE_AI_BACKEND_URL` is baked at the GitHub Actions build with a runtime override field in the ChatDrawer.

**Tech Stack:** Hono + tsx (Node ESM), Docker (node-alpine, buildah CI), Helm, ArgoCD, nginx-ingress + cert-manager, Cloudflare Pages + DNS (Terraform), Vue 3 + Vite frontend.

**Source spec:** `docs/superpowers/specs/2026-06-15-backend-deployment-design.md`

**Repos touched** (all get a `feature/ai-enhancement` branch):
- `~/ultra/ultra-tool-kit` (already on `feature/ai-enhancement`) — Dockerfile, `/health`, CI, frontend.
- `~/ultra/helm-charts` (currently `master`) — Helm chart.
- `~/ultra/ultra-apps` — ArgoCD app + values.
- `~/ultra/terraform` — Cloudflare DNS record.

**Note on commits:** End every commit message with:
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```
Do **not** push any branch — pushing/PRs are out of scope for this plan unless the user asks.

---

## Phase 1 — Backend deployability (repo: `ultra-tool-kit`)

### Task 1: Add a `GET /health` route to the backend

**Files:**
- Modify: `backend/src/index.ts` (inside `createApp`, after the `cors` middleware ~line 109)
- Test: `backend/test/health.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/test/health.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createApp, type AppConfig } from '../src/index.js';
import type { ChatProvider } from '../src/llm/provider.js';

// Minimal config; the only provider method used at boot is modelTag() (index.ts:138).
const cfg: AppConfig = {
    allowedOrigins: ['http://localhost:5172'],
    devRatelimitBypass: true,
    llmProvider: 'anthropic',
    allowedChainHosts: [],
};

const stubProvider = {
    modelTag: () => 'claude-haiku-4-5-20251001',
} as unknown as ChatProvider;

describe('GET /health', () => {
    it('returns 200 {ok:true} without auth, outside the /api chain', async () => {
        const app = await createApp(cfg, { provider: stubProvider });
        const res = await app.request('/health');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
    });
});
```

> If the import style fails, mirror the exact import specifiers used in `backend/test/baseline.test.ts` (this is an ESM project that uses `.js` specifiers for TS sources).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix backend test -- health`
Expected: FAIL — `GET /health` currently 404s, so `res.status` is `404`, not `200`.

- [ ] **Step 3: Implement the route**

In `backend/src/index.ts`, immediately after the existing CORS line:

```ts
    app.use('*', cors({ origin: cfg.allowedOrigins, allowMethods: ['GET', 'POST', 'OPTIONS'] }));

    // Health probe for k8s liveness/readiness. Unauthenticated, no LLM, and
    // mounted OUTSIDE the /api/* attestation + rate-limit + quota chain so probes
    // never consume quota or reach a provider.
    app.get('/health', (c) => c.json({ ok: true }));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix backend test -- health`
Expected: PASS.

- [ ] **Step 5: Run the full backend suite to confirm no regression**

Run: `npm --prefix backend test`
Expected: all tests pass (the new `/health` route is additive and outside existing route paths).

- [ ] **Step 6: Commit**

```bash
cd ~/ultra/ultra-tool-kit
git add backend/src/index.ts backend/test/health.test.ts
git commit -m "feat(ai): add unauthenticated GET /health for k8s probes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Add the backend Dockerfile and .dockerignore

**Files:**
- Create: `backend/Dockerfile`
- Create: `backend/.dockerignore`

- [ ] **Step 1: Create `backend/.dockerignore`**

```
node_modules
logs
.env
.env.*
test
docs
*.md
```

- [ ] **Step 2: Create `backend/Dockerfile`**

```dockerfile
# Multi-stage build for the Ultra Tool Kit AI backend (Hono, run via tsx — no
# tsc/dist compile step). Mirrors the ultra-claim Dockerfile structure (alpine,
# multi-stage, deps copied into a clean runtime stage), adapted for tsx.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# web-tree-sitter / tree-sitter-cpp are WASM (no native build per backend/CLAUDE.md).
# If npm ci ever fails on a native module, add:
#   RUN apk add --no-cache python3 make g++
RUN npm ci

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Keep the V8 heap under the lean 256Mi pod limit.
ENV NODE_OPTIONS=--max-old-space-size=192

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY catalog ./catalog
# Append-only usage telemetry target (ephemeral per-pod; acceptable, no DB).
RUN mkdir -p logs && chown -R node:node /app

USER node
EXPOSE 8787
# start = "tsx src/index.ts" (package.json). tsx resolves the .js import
# specifiers to the .ts sources at runtime.
CMD ["npm", "start"]
```

> Verify `node:22-alpine` is a current LTS tag at build time (`docker pull node:22-alpine`). Node 22 is LTS; bump to the current LTS alpine tag if the team standard differs.

- [ ] **Step 3: Build the image to verify it succeeds**

Run:
```bash
cd ~/ultra/ultra-tool-kit/backend
docker build -t ultra-tool-kit-backend:dev -f Dockerfile .
```
Expected: build completes; final stage tagged `ultra-tool-kit-backend:dev`.

- [ ] **Step 4: Smoke-run the container to verify it listens and /health works**

Run:
```bash
docker run --rm -d --name utk-be -p 8787:8787 \
  -e BIND_HOST=0.0.0.0 -e BIND_PORT=8787 \
  -e ALLOWED_ORIGINS=http://localhost:5172 \
  -e LLM_PROVIDER=anthropic -e ANTHROPIC_API_KEY=dummy-not-used-by-health \
  ultra-tool-kit-backend:dev
sleep 4
curl -fsS http://localhost:8787/health
docker logs utk-be | tail -5
docker rm -f utk-be
```
Expected: `curl` prints `{"ok":true}`; logs include `backend listening` with `host: '0.0.0.0'`.

- [ ] **Step 5: Commit**

```bash
cd ~/ultra/ultra-tool-kit
git add backend/Dockerfile backend/.dockerignore
git commit -m "build(ai): backend Dockerfile + .dockerignore (multi-stage alpine, tsx runtime)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Add the release-triggered image build+push workflow

**Files:**
- Create: `.github/workflows/docker-publish.yml`

> Mirrors `~/ultra/ultra-claim/.github/workflows/docker-publish.yml` verbatim except image name / context / containerfile. Uses Workload Identity via the `REG_WIF` repo secret — the same secret ultra-claim uses, so it is functional once `REG_WIF` is configured on this repo.

- [ ] **Step 1: Create `.github/workflows/docker-publish.yml`**

```yaml
name: docker-publish-ci

on:
  release:
    types: [created]
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read

    steps:
      - name: Checkout
        uses: actions/checkout@v3

      - id: "auth"
        name: "Authenticate to Google Cloud"
        uses: "google-github-actions/auth@v1"
        with:
          token_format: "access_token"
          workload_identity_provider: "${{ secrets.REG_WIF }}"
          service_account: "wif-gar@ultra-registry.iam.gserviceaccount.com"

      - name: Build Image
        id: build-image
        uses: redhat-actions/buildah-build@v2
        with:
          image: ultra-registry/docker/ultra-tool-kit-backend
          tags: latest ${{ github.sha }} ${{ github.event.release.tag_name }}
          context: ./backend
          containerfiles: ./backend/Dockerfile

      - name: Push To GCR
        id: push-to-gcr
        uses: redhat-actions/push-to-registry@v2
        with:
          image: ${{ steps.build-image.outputs.image }}
          tags: ${{ steps.build-image.outputs.tags }}
          registry: europe-west1-docker.pkg.dev
          username: oauth2accesstoken
          password: ${{ steps.auth.outputs.access_token }}

      - name: Print image url
        run: echo "Image pushed to ${{ steps.push-to-gcr.outputs.registry-paths }}"
```

- [ ] **Step 2: Validate the workflow YAML**

Run (if `actionlint` is available, else use a YAML linter):
```bash
cd ~/ultra/ultra-tool-kit
actionlint .github/workflows/docker-publish.yml || python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/docker-publish.yml')); print('yaml ok')"
```
Expected: no errors (`actionlint` clean, or `yaml ok`).

- [ ] **Step 3: Commit**

```bash
cd ~/ultra/ultra-tool-kit
git add .github/workflows/docker-publish.yml
git commit -m "ci(ai): release-triggered backend image build+push to Artifact Registry

Mirrors ultra-claim docker-publish.yml (WIF auth via REG_WIF). Image:
europe-west1-docker.pkg.dev/ultra-registry/docker/ultra-tool-kit-backend.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — Helm chart (repo: `helm-charts`)

### Task 4: Create the branch and chart skeleton (Chart.yaml, values.yaml, _helpers)

**Files:**
- Create: `charts/ultra-tool-kit-backend/Chart.yaml`
- Create: `charts/ultra-tool-kit-backend/values.yaml`
- Create: `charts/ultra-tool-kit-backend/templates/_helpers.tpl`

- [ ] **Step 1: Create the branch**

```bash
cd ~/ultra/helm-charts
git checkout master && git pull --ff-only || true
git checkout -b feature/ai-enhancement
```
Expected: on a new branch `feature/ai-enhancement`.

- [ ] **Step 2: Create `charts/ultra-tool-kit-backend/Chart.yaml`**

```yaml
apiVersion: v2
name: ultra-tool-kit-backend
description: Helm chart for the Ultra Tool Kit AI backend (stateless Hono service)
type: application
version: 0.1.0
appVersion: "0.1.0"
```

- [ ] **Step 3: Create `charts/ultra-tool-kit-backend/values.yaml`**

```yaml
replicaCount: 1

image:
  repository: europe-west1-docker.pkg.dev/ultra-registry/docker/ultra-tool-kit-backend
  pullPolicy: IfNotPresent
  tag: ""                       # overridden per-env in ultra-apps

imagePullSecrets: []
nameOverride: ""
fullnameOverride: ""

serviceAccount:
  create: true
  annotations: {}
  name: ""

podAnnotations: {}
podSecurityContext: {}
securityContext: {}

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
      paths:
        - path: /
          pathType: ImplementationSpecific
  tls:
    - secretName: ai-toolkit-prod-tls
      hosts:
        - ai-toolkit.ultra.io

resources:
  requests:
    memory: "128Mi"
    cpu: "100m"
  limits:
    memory: "256Mi"
    cpu: "500m"

autoscaling:
  enabled: false

pdb:
  maxUnavailable: 1

nodeSelector:
  role: application

tolerations: []
affinity: {}

# Non-secret env -> ConfigMap
config:
  BIND_HOST: "0.0.0.0"
  BIND_PORT: "8787"
  LLM_PROVIDER: "anthropic"
  ANTHROPIC_CHAT_MODEL: "claude-haiku-4-5-20251001"
  ALLOWED_ORIGINS: "https://toolkit.ultra.io"

# ANTHROPIC_API_KEY delivery. Default: reference an existing Secret by name
# (raw key NOT in git). Escape hatch: secret.create=true templates secret.yaml
# from anthropicApiKey (filling that value commits the key — avoid).
secret:
  create: false
  existingSecret: "ultra-tool-kit-backend-secrets"
  apiKeyKey: "ANTHROPIC_API_KEY"
  anthropicApiKey: ""

livenessProbe:
  httpGet:
    path: /health
    port: http
  initialDelaySeconds: 10
  periodSeconds: 20
  timeoutSeconds: 3

readinessProbe:
  httpGet:
    path: /health
    port: http
  initialDelaySeconds: 5
  periodSeconds: 10
  timeoutSeconds: 3
  failureThreshold: 3
```

- [ ] **Step 4: Create `charts/ultra-tool-kit-backend/templates/_helpers.tpl`**

```yaml
{{- define "ultra-tool-kit-backend.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "ultra-tool-kit-backend.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "ultra-tool-kit-backend.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "ultra-tool-kit-backend.labels" -}}
helm.sh/chart: {{ include "ultra-tool-kit-backend.chart" . }}
app.kubernetes.io/component: "backend"
{{ include "ultra-tool-kit-backend.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "ultra-tool-kit-backend.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ultra-tool-kit-backend.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "ultra-tool-kit-backend.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "ultra-tool-kit-backend.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* Name of the Secret that holds ANTHROPIC_API_KEY */}}
{{- define "ultra-tool-kit-backend.secretName" -}}
{{- if .Values.secret.create }}
{{- include "ultra-tool-kit-backend.fullname" . }}
{{- else }}
{{- .Values.secret.existingSecret }}
{{- end }}
{{- end }}
```

- [ ] **Step 5: Commit**

```bash
cd ~/ultra/helm-charts
git add charts/ultra-tool-kit-backend/Chart.yaml charts/ultra-tool-kit-backend/values.yaml charts/ultra-tool-kit-backend/templates/_helpers.tpl
git commit -m "feat(ultra-tool-kit-backend): chart skeleton (Chart, values, helpers)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Add the chart templates (deployment, service, configmap, secret, serviceaccount, ingress, pdb, NOTES)

**Files:**
- Create: `charts/ultra-tool-kit-backend/templates/deployment.yaml`
- Create: `charts/ultra-tool-kit-backend/templates/service.yaml`
- Create: `charts/ultra-tool-kit-backend/templates/configmap.yaml`
- Create: `charts/ultra-tool-kit-backend/templates/secret.yaml`
- Create: `charts/ultra-tool-kit-backend/templates/serviceaccount.yaml`
- Create: `charts/ultra-tool-kit-backend/templates/ingress.yaml`
- Create: `charts/ultra-tool-kit-backend/templates/pdb.yaml`
- Create: `charts/ultra-tool-kit-backend/templates/NOTES.txt`

- [ ] **Step 1: Create `templates/deployment.yaml`**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "ultra-tool-kit-backend.fullname" . }}
  labels:
    {{- include "ultra-tool-kit-backend.labels" . | nindent 4 }}
spec:
  {{- if not .Values.autoscaling.enabled }}
  replicas: {{ .Values.replicaCount }}
  {{- end }}
  selector:
    matchLabels:
      {{- include "ultra-tool-kit-backend.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
        {{- with .Values.podAnnotations }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
      labels:
        {{- include "ultra-tool-kit-backend.selectorLabels" . | nindent 8 }}
    spec:
      {{- with .Values.imagePullSecrets }}
      imagePullSecrets:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      serviceAccountName: {{ include "ultra-tool-kit-backend.serviceAccountName" . }}
      securityContext:
        {{- toYaml .Values.podSecurityContext | nindent 8 }}
      containers:
        - name: {{ .Chart.Name }}
          securityContext:
            {{- toYaml .Values.securityContext | nindent 12 }}
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports:
            - name: http
              containerPort: 8787
              protocol: TCP
          envFrom:
            - configMapRef:
                name: {{ include "ultra-tool-kit-backend.fullname" . }}
          env:
            - name: ANTHROPIC_API_KEY
              valueFrom:
                secretKeyRef:
                  name: {{ include "ultra-tool-kit-backend.secretName" . }}
                  key: {{ .Values.secret.apiKeyKey }}
          livenessProbe:
            {{- toYaml .Values.livenessProbe | nindent 12 }}
          readinessProbe:
            {{- toYaml .Values.readinessProbe | nindent 12 }}
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
      {{- with .Values.nodeSelector }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with .Values.affinity }}
      affinity:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with .Values.tolerations }}
      tolerations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
```

- [ ] **Step 2: Create `templates/service.yaml`**

```yaml
apiVersion: v1
kind: Service
metadata:
  name: {{ include "ultra-tool-kit-backend.fullname" . }}
  labels:
    {{- include "ultra-tool-kit-backend.labels" . | nindent 4 }}
spec:
  type: {{ .Values.service.type }}
  ports:
    - port: {{ .Values.service.port }}
      targetPort: http
      protocol: TCP
      name: http
  selector:
    {{- include "ultra-tool-kit-backend.selectorLabels" . | nindent 4 }}
```

- [ ] **Step 3: Create `templates/configmap.yaml`**

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "ultra-tool-kit-backend.fullname" . }}
  labels:
    {{- include "ultra-tool-kit-backend.labels" . | nindent 4 }}
data:
  {{- range $key, $val := .Values.config }}
  {{ $key }}: {{ $val | quote }}
  {{- end }}
```

- [ ] **Step 4: Create `templates/secret.yaml`**

```yaml
{{- if .Values.secret.create }}
apiVersion: v1
kind: Secret
metadata:
  name: {{ include "ultra-tool-kit-backend.fullname" . }}
  labels:
    {{- include "ultra-tool-kit-backend.labels" . | nindent 4 }}
type: Opaque
stringData:
  {{ .Values.secret.apiKeyKey }}: {{ required "secret.anthropicApiKey is required when secret.create=true" .Values.secret.anthropicApiKey | quote }}
{{- end }}
```

- [ ] **Step 5: Create `templates/serviceaccount.yaml`**

```yaml
{{- if .Values.serviceAccount.create }}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ include "ultra-tool-kit-backend.serviceAccountName" . }}
  labels:
    {{- include "ultra-tool-kit-backend.labels" . | nindent 4 }}
  {{- with .Values.serviceAccount.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
{{- end }}
```

- [ ] **Step 6: Create `templates/ingress.yaml`**

```yaml
{{- if .Values.ingress.enabled -}}
{{- $fullName := include "ultra-tool-kit-backend.fullname" . -}}
{{- $svcPort := .Values.service.port -}}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ $fullName }}
  labels:
    {{- include "ultra-tool-kit-backend.labels" . | nindent 4 }}
  {{- with .Values.ingress.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
spec:
  {{- if .Values.ingress.className }}
  ingressClassName: {{ .Values.ingress.className }}
  {{- end }}
  {{- if .Values.ingress.tls }}
  tls:
    {{- range .Values.ingress.tls }}
    - hosts:
        {{- range .hosts }}
        - {{ . | quote }}
        {{- end }}
      secretName: {{ .secretName }}
    {{- end }}
  {{- end }}
  rules:
    {{- range .Values.ingress.hosts }}
    - host: {{ .host | quote }}
      http:
        paths:
          {{- range .paths }}
          - path: {{ .path }}
            {{- with .pathType }}
            pathType: {{ . }}
            {{- end }}
            backend:
              service:
                name: {{ $fullName }}
                port:
                  number: {{ $svcPort }}
          {{- end }}
    {{- end }}
{{- end }}
```

- [ ] **Step 7: Create `templates/pdb.yaml`**

```yaml
{{- if .Values.pdb }}
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {{ include "ultra-tool-kit-backend.fullname" . }}
  labels:
    {{- include "ultra-tool-kit-backend.labels" . | nindent 4 }}
spec:
  maxUnavailable: {{ .Values.pdb.maxUnavailable }}
  selector:
    matchLabels:
      {{- include "ultra-tool-kit-backend.selectorLabels" . | nindent 6 }}
{{- end }}
```

- [ ] **Step 8: Create `templates/NOTES.txt`**

```
{{ include "ultra-tool-kit-backend.fullname" . }} deployed.

Service (ClusterIP): {{ include "ultra-tool-kit-backend.fullname" . }}:{{ .Values.service.port }}
{{- if .Values.ingress.enabled }}
Public host:
{{- range .Values.ingress.hosts }}
  https://{{ .host }}
{{- end }}
{{- end }}

ANTHROPIC_API_KEY source: {{ if .Values.secret.create }}chart-created Secret{{ else }}existing Secret "{{ .Values.secret.existingSecret }}"{{ end }} (key {{ .Values.secret.apiKeyKey }}).
{{- if not .Values.secret.create }}
Create it once:
  kubectl -n {{ .Release.Namespace }} create secret generic {{ .Values.secret.existingSecret }} \
    --from-literal={{ .Values.secret.apiKeyKey }}=<key> --dry-run=client -o yaml | kubectl apply -f -
{{- end }}
```

- [ ] **Step 9: Lint and render the chart**

Run:
```bash
cd ~/ultra/helm-charts
helm lint charts/ultra-tool-kit-backend
helm template utk charts/ultra-tool-kit-backend --namespace prod-env | head -120
```
Expected: `helm lint` reports `0 chart(s) failed`. `helm template` renders Deployment (with `httpGet /health` probes, `envFrom` configmap, `secretKeyRef`), Service (ClusterIP:8787), ConfigMap, ServiceAccount, Ingress (host `ai-toolkit.ultra.io`, TLS secret), PDB — and **no** Secret (because `secret.create=false`).

- [ ] **Step 10: Verify the escape-hatch path renders a Secret**

Run:
```bash
cd ~/ultra/helm-charts
helm template utk charts/ultra-tool-kit-backend \
  --set secret.create=true --set secret.anthropicApiKey=test123 \
  | grep -A3 "kind: Secret"
```
Expected: a `kind: Secret` block with `ANTHROPIC_API_KEY` present.

- [ ] **Step 11: Commit**

```bash
cd ~/ultra/helm-charts
git add charts/ultra-tool-kit-backend/templates
git commit -m "feat(ultra-tool-kit-backend): chart templates (deploy/svc/cm/secret/sa/ingress/pdb)

Lean stateless backend: ClusterIP:8787, nginx ingress at ai-toolkit.ultra.io
with cert-manager TLS, httpGet /health probes, ANTHROPIC_API_KEY via
secretKeyRef to an existing Secret by name.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3 — ArgoCD application (repo: `ultra-apps`)

### Task 6: Add the prod ArgoCD app + values

**Files:**
- Create: `argocd-apps/ultra/prod-env/ultra-tool-kit-backend/ultra-tool-kit-backend-prod-app.yaml`
- Create: `argocd-apps/ultra/prod-env/ultra-tool-kit-backend/ultra-tool-kit-backend-prod-values.yaml`

- [ ] **Step 1: Create the branch**

```bash
cd ~/ultra/ultra-apps
git checkout -b feature/ai-enhancement
```
Expected: on a new branch `feature/ai-enhancement`.

- [ ] **Step 2: Create `...-prod-app.yaml`**

Path: `argocd-apps/ultra/prod-env/ultra-tool-kit-backend/ultra-tool-kit-backend-prod-app.yaml`

```yaml
---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ultra-tool-kit-backend-prod
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: ultra-prod-env-apps
  sources:
    - repoURL: https://gitlab.com/ultraio/devops/helm-charts.git
      targetRevision: feature/ai-enhancement
      path: charts/ultra-tool-kit-backend
      helm:
        valueFiles:
          - $values/argocd-apps/ultra/prod-env/ultra-tool-kit-backend/ultra-tool-kit-backend-prod-values.yaml
    - repoURL: https://gitlab.com/ultraio/devops/ultra-apps.git
      targetRevision: HEAD
      ref: values
  destination:
    name: ultra-prod
    namespace: prod-env
  syncPolicy:
    automated:
      selfHeal: true
      allowEmpty: false
    syncOptions:
      - Validate=false
      - CreateNamespace=true
      - PrunePropagationPolicy=foreground
      - PruneLast=true
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m
```

> `targetRevision: feature/ai-enhancement` tracks the helm-charts branch until the chart is released and tagged. Once a chart tag exists, switch it to `ultra-tool-kit-backend-0.1.0` (matching the `<chart>-<version>` convention used by every other prod app).

- [ ] **Step 3: Create `...-prod-values.yaml`**

Path: `argocd-apps/ultra/prod-env/ultra-tool-kit-backend/ultra-tool-kit-backend-prod-values.yaml`

```yaml
replicaCount: 1

image:
  repository: europe-west1-docker.pkg.dev/ultra-registry/docker/ultra-tool-kit-backend
  pullPolicy: IfNotPresent
  tag: "0.1.0"          # set to the released image tag (SHA or release tag)

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
      paths:
        - path: /
          pathType: ImplementationSpecific
  tls:
    - secretName: ai-toolkit-prod-tls
      hosts:
        - ai-toolkit.ultra.io

resources:
  requests:
    memory: "128Mi"
    cpu: "100m"
  limits:
    memory: "256Mi"
    cpu: "500m"

config:
  BIND_HOST: "0.0.0.0"
  BIND_PORT: "8787"
  LLM_PROVIDER: "anthropic"
  ANTHROPIC_CHAT_MODEL: "claude-haiku-4-5-20251001"
  ALLOWED_ORIGINS: "https://toolkit.ultra.io"

secret:
  create: false
  existingSecret: "ultra-tool-kit-backend-secrets"
  apiKeyKey: "ANTHROPIC_API_KEY"
```

- [ ] **Step 4: Validate the YAML and render against the local chart**

Run:
```bash
cd ~/ultra/ultra-apps
python3 -c "import yaml; [yaml.safe_load(open(f)) for f in ['argocd-apps/ultra/prod-env/ultra-tool-kit-backend/ultra-tool-kit-backend-prod-app.yaml','argocd-apps/ultra/prod-env/ultra-tool-kit-backend/ultra-tool-kit-backend-prod-values.yaml']]; print('yaml ok')"
helm template utk ~/ultra/helm-charts/charts/ultra-tool-kit-backend \
  -f argocd-apps/ultra/prod-env/ultra-tool-kit-backend/ultra-tool-kit-backend-prod-values.yaml \
  --namespace prod-env >/dev/null && echo "render ok"
```
Expected: `yaml ok` and `render ok`.

- [ ] **Step 5: Commit**

```bash
cd ~/ultra/ultra-apps
git add argocd-apps/ultra/prod-env/ultra-tool-kit-backend
git commit -m "feat(ultra-tool-kit-backend): prod ArgoCD app + values

Mirrors ultra-claim. ClusterIP backend behind nginx ingress at
ai-toolkit.ultra.io; chart tracked from helm-charts feature/ai-enhancement
until a chart tag exists.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 4 — Cloudflare DNS (repo: `terraform`)

### Task 7: Add the `ai-toolkit.ultra.io` DNS record (or confirm external-dns)

**Files:**
- Possibly modify: a file under `~/ultra/terraform/cloudflare/dns/` (only if DNS is managed manually)

- [ ] **Step 1: Create the branch**

```bash
cd ~/ultra/terraform
git checkout main && git pull --ff-only || true
git checkout -b feature/ai-enhancement
```
Expected: on a new branch `feature/ai-enhancement`.

- [ ] **Step 2: Determine whether DNS is auto-created by external-dns**

Run:
```bash
grep -rIn "external-dns\|external_dns\|externaldns" ~/ultra/ultra-apps ~/ultra/helm-charts 2>/dev/null | head
grep -rIn "claimrequest" ~/ultra/terraform 2>/dev/null | head
```
Expected: tells you (a) whether external-dns is deployed (it would auto-create `ai-toolkit.ultra.io` from the ingress — then **no terraform change is needed**, skip to Step 4 and just record that finding), and (b) how `claimrequest.ultra.io` (the ultra-claim backend host) is wired, which is the exact pattern to copy.

- [ ] **Step 3: If DNS is manual, add the record mirroring `claimrequest.ultra.io`**

If `claimrequest.ultra.io` has an explicit `cloudflare_record` in `~/ultra/terraform/cloudflare/dns/`, add an equivalent for `ai-toolkit`, copying the same `zone_id`/target/`proxied` values it uses. Example shape (match the existing file's exact module/resource style and the prod nginx-ingress LB target it points at):

```hcl
resource "cloudflare_record" "ai_toolkit" {
  zone_id = data.cloudflare_zones.ultra-io.zones[0].id
  name    = "ai-toolkit"
  type    = "CNAME"               # match claimrequest's record type/target
  content = "<same target claimrequest.ultra.io uses>"
  proxied = true
  comment = "Ultra Tool Kit AI backend ingress"
}
```

> Do not invent the LB target — use exactly what `claimrequest.ultra.io` resolves to in the existing terraform. If `claimrequest` is itself created by external-dns (no terraform record), then this app is too — make no terraform change.

- [ ] **Step 4: Validate**

If you added HCL:
```bash
cd ~/ultra/terraform/cloudflare/dns
terraform fmt
terraform validate || echo "validate needs provider init; fmt is the local gate"
```
Expected: `terraform fmt` leaves the file clean; `terraform validate` passes (or note it needs `terraform init` with backend creds — `fmt` is the offline gate).

- [ ] **Step 5: Commit (only if a file changed)**

```bash
cd ~/ultra/terraform
git add -A cloudflare/dns
git commit -m "feat(dns): proxied CF record for ai-toolkit.ultra.io (tool-kit AI backend)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
If external-dns owns the record, skip the commit and note "DNS auto-created by external-dns; no terraform change" in the task handoff.

---

## Phase 5 — Frontend wiring (repo: `ultra-tool-kit`)

### Task 8: Make the backend URL runtime-configurable in `aiClient.ts`

**Files:**
- Modify: `src/utilities/aiClient.ts:90-103`

- [ ] **Step 1: Replace the base-URL block**

Replace lines 90–103 (`const DEFAULT_BASE_URL ...` through the end of `getBaseUrl`) with:

```ts
const DEFAULT_BASE_URL = 'http://localhost:8787';
// User-set override (e.g. a kubectl port-forward or a custom backend). Wins over
// the build-time VITE_AI_BACKEND_URL so the static CF-Pages bundle is repointable
// without a rebuild. Mirrors how custom RPC endpoints are stored (Endpoint.vue).
const BASE_URL_STORAGE_KEY = 'aiBackendUrl';
// Must outlast the backend's per-turn wall-clock budget (hosted ~15s, local
// Ollama ~60s — see backend ai-chat.ts / LLM_MAX_WALL_MS) plus network overhead,
// so a slow local "thinking" turn completes instead of the client aborting it.
const REQUEST_TIMEOUT_MS = 90_000;
// Local Ollama turns commonly run 3–8 s with the retry pass; 5 s caused the
// hint to fire on every turn. 8 s surfaces the "thinking" state on genuinely
// slow (cold-load / reasoning) turns without nagging on fast ones.
const WARMING_HINT_MS = 8_000;

export function getStoredBaseUrl(): string | null {
    try {
        return localStorage.getItem(BASE_URL_STORAGE_KEY)?.trim() || null;
    } catch {
        return null;
    }
}

export function setBaseUrl(url: string): void {
    const trimmed = url.trim();
    if (trimmed) localStorage.setItem(BASE_URL_STORAGE_KEY, trimmed);
    else localStorage.removeItem(BASE_URL_STORAGE_KEY);
}

export function clearBaseUrl(): void {
    localStorage.removeItem(BASE_URL_STORAGE_KEY);
}

export function getEnvBaseUrl(): string | null {
    const fromEnv = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_AI_BACKEND_URL;
    return fromEnv?.trim() || null;
}

// Resolution order: user override -> build env -> localhost default.
export function getBaseUrl(): string {
    return getStoredBaseUrl() || getEnvBaseUrl() || DEFAULT_BASE_URL;
}

// Reachability + CORS sanity check for the settings UI. Hits the unauthenticated
// /health route; a disallowed origin or unreachable host both resolve to false.
export async function pingBackend(url: string): Promise<boolean> {
    try {
        const res = await fetch(`${url.replace(/\/+$/, '')}/health`, { method: 'GET' });
        return res.ok;
    } catch {
        return false;
    }
}
```

> Note: the original block defined `REQUEST_TIMEOUT_MS` and `WARMING_HINT_MS` right after `DEFAULT_BASE_URL`. They are preserved verbatim above — do not duplicate them elsewhere in the file.

- [ ] **Step 2: Typecheck the frontend**

Run: `cd ~/ultra/ultra-tool-kit && npx vue-tsc --noEmit -p tsconfig.json`
Expected: no type errors. (The frontend has no unit-test runner — `vue-tsc` is the gate, the same one `npm run build` runs.)

- [ ] **Step 3: Commit**

```bash
cd ~/ultra/ultra-tool-kit
git add src/utilities/aiClient.ts
git commit -m "feat(ai): runtime-configurable backend URL (localStorage override + ping)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Add the backend-URL settings field to the ChatDrawer

**Files:**
- Modify: `src/components/ai/ChatDrawer.vue` (header buttons ~line 24-49; script setup ~line 213+)

- [ ] **Step 1: Add a gear button to the header**

In the header `<div class="flex items-center gap-2">` (the button row), add as the FIRST button (before the fullscreen button):

```html
                            <button
                                class="p-1.5 text-neutral-400 hover:text-neutral-100"
                                title="Backend settings"
                                @click="showSettings = !showSettings"
                                data-testid="ai-chat-settings"
                            >
                                <Icon icon="fa-gear" />
                            </button>
```

> If `fa-gear` is not registered, add it to the `library.add(...)` call in `src/icons.ts` (per the project convention) in this same task.

- [ ] **Step 2: Add the settings panel below the header**

Immediately AFTER the closing `</header>` tag, add:

```html
                    <!-- Backend URL settings -->
                    <div
                        v-if="showSettings"
                        class="px-4 py-3 border-b border-neutral-700 bg-neutral-800/60 text-sm"
                        data-testid="ai-chat-settings-panel"
                    >
                        <label class="block text-xs text-neutral-400 mb-1">AI backend URL</label>
                        <div class="flex gap-2">
                            <input
                                v-model="backendUrlDraft"
                                placeholder="http://localhost:8787"
                                class="flex-grow rounded bg-neutral-950 text-neutral-200 px-3 py-1"
                            />
                            <button
                                class="px-3 rounded bg-purple-700 hover:bg-purple-600 disabled:opacity-50"
                                :disabled="checkingBackend"
                                @click="saveBackendUrl"
                            >
                                <Icon :icon="checkingBackend ? 'fa-spinner' : 'fa-check'" :spin="checkingBackend" />
                            </button>
                        </div>
                        <div class="mt-1 flex items-center justify-between text-xs">
                            <span class="text-neutral-500">Active: {{ activeBackendUrl }}</span>
                            <button class="text-neutral-400 hover:text-neutral-200 underline" @click="resetBackendUrl">
                                Reset to default
                            </button>
                        </div>
                        <p v-if="backendMsg" class="mt-1 text-xs" :class="backendOk ? 'text-emerald-400' : 'text-red-400'">
                            {{ backendMsg }}
                        </p>
                    </div>
```

- [ ] **Step 3: Wire the script setup**

Add to the imports (alongside the existing aiClient import — check the file's existing import path for aiClient and extend it):

```ts
import { getBaseUrl, getStoredBaseUrl, setBaseUrl, clearBaseUrl, pingBackend } from '../../utilities/aiClient';
```

Then in `<script setup>` (near the `fullscreen` ref ~line 219), add:

```ts
const showSettings = ref<boolean>(false);
const activeBackendUrl = ref<string>(getBaseUrl());
const backendUrlDraft = ref<string>(getStoredBaseUrl() ?? '');
const checkingBackend = ref<boolean>(false);
const backendMsg = ref<string>('');
const backendOk = ref<boolean>(false);

async function saveBackendUrl() {
    const url = backendUrlDraft.value.trim();
    if (!url) {
        clearBaseUrl();
        activeBackendUrl.value = getBaseUrl();
        backendOk.value = true;
        backendMsg.value = 'Reset to default.';
        return;
    }
    checkingBackend.value = true;
    backendMsg.value = '';
    const reachable = await pingBackend(url);
    checkingBackend.value = false;
    backendOk.value = reachable;
    if (reachable) {
        setBaseUrl(url);
        activeBackendUrl.value = getBaseUrl();
        backendMsg.value = 'Saved — backend reachable.';
    } else {
        backendMsg.value = "Couldn't reach that URL (unreachable or origin not allowed). Saved anyway? Re-check the URL.";
    }
}

function resetBackendUrl() {
    clearBaseUrl();
    backendUrlDraft.value = '';
    activeBackendUrl.value = getBaseUrl();
    backendOk.value = true;
    backendMsg.value = 'Reset to default.';
}
```

> If `ref` is not already imported in this file, add it to the existing `import { ... } from 'vue'` line.

- [ ] **Step 4: Typecheck the frontend**

Run: `cd ~/ultra/ultra-tool-kit && npx vue-tsc --noEmit -p tsconfig.json`
Expected: no type errors.

- [ ] **Step 5: Visually verify in the dev server**

Start the dev server (`npm run dev`), open the chat drawer, click the gear → the settings panel appears with the URL field, "Active:" line, and reset link. Enter `http://localhost:8787` and Save; with a local backend running it shows "backend reachable". Confirm via the preview tools (snapshot/screenshot), not by asking the user.

- [ ] **Step 6: Commit**

```bash
cd ~/ultra/ultra-tool-kit
git add src/components/ai/ChatDrawer.vue src/icons.ts
git commit -m "feat(ai): backend-URL settings field in ChatDrawer (gear -> validated input)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Inject `VITE_AI_BACKEND_URL` at the GitHub Actions build

**Files:**
- Modify: `.github/workflows/gh-page.yml` (the `Build` step, ~line 23-24)

- [ ] **Step 1: Add the env to the Build step**

Change:
```yaml
            - name: Build
              run: npm run build
```
to:
```yaml
            - name: Build
              run: npm run build
              env:
                  VITE_AI_BACKEND_URL: ${{ vars.VITE_AI_BACKEND_URL }}
```

> `vars.VITE_AI_BACKEND_URL` is a repository variable (Settings → Secrets and variables → Actions → Variables), e.g. `https://ai-toolkit.ultra.io`. If unset, Vite inlines an empty string and `getBaseUrl()` falls back to the localhost default — harmless; the runtime field still works.

- [ ] **Step 2: Validate the workflow YAML**

Run:
```bash
cd ~/ultra/ultra-tool-kit
actionlint .github/workflows/gh-page.yml || python3 -c "import yaml; yaml.safe_load(open('.github/workflows/gh-page.yml')); print('yaml ok')"
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd ~/ultra/ultra-tool-kit
git add .github/workflows/gh-page.yml
git commit -m "ci(ai): bake VITE_AI_BACKEND_URL into the CF Pages build

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] Backend: `npm --prefix backend test` passes; `docker build -f backend/Dockerfile backend/` succeeds; container `GET /health` → `{"ok":true}`.
- [ ] Chart: `helm lint charts/ultra-tool-kit-backend` clean; `helm template ... -f <prod-values>` renders Deployment/Service/ConfigMap/Ingress/PDB/SA with lean resources + `httpGet /health` + `secretKeyRef`, no Secret by default.
- [ ] ArgoCD + values YAML parse and render against the chart.
- [ ] DNS: terraform `fmt`/`validate` clean, or documented external-dns auto-creation.
- [ ] Frontend: `vue-tsc --noEmit` clean; ChatDrawer gear shows the working settings field.
- [ ] Branches `feature/ai-enhancement` exist in ultra-tool-kit, helm-charts, ultra-apps, terraform.
- [ ] Per the project memory ["Simplify after features"], dispatch the `code-simplifier` over the changed frontend/backend source files (exclude generated chart YAML / CI / docs) before final hand-off; re-run typecheck/tests after.
```
