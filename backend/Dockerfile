# Multi-stage build for the Ultra Tool Kit AI backend (Hono, run via tsx — no
# tsc/dist compile step). Mirrors the ultra-claim Dockerfile structure (alpine,
# multi-stage, deps copied into a clean runtime stage), adapted for tsx.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# web-tree-sitter / tree-sitter-cpp are WASM, but tree-sitter-c (a transitive
# dep of tree-sitter-cpp) has a native binding that node-gyp must compile.
RUN apk add --no-cache python3 make g++
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
