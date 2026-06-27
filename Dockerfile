# syntax=docker/dockerfile:1.7
# ^ MUST be the first line for BuildKit to honor `--mount=type=secret` below.
#
# repid-engine — portable multi-stage Dockerfile
# Builds & runs IDENTICALLY on Railway, Fly.io, and Coolify (no host-specific build steps).
#
# WHY THIS EXISTS: Railway uses nixpacks today (nixpacks.toml: npm install --legacy-peer-deps).
# This Dockerfile is the host-agnostic substrate for the Fly.io warm standby (and a future
# Coolify consolidation). Adding it changes NOTHING for Railway (Railway still builds via nixpacks
# unless a railway.toml [build] builder is switched to DOCKERFILE — not done here).
#
# BUILD GOTCHA — git-pinned private dependency:
#   package.json: "@hyperdag/proof-verifier": "github:DealAppSeo/hyperdag-proof-verifier#ec3930a4..."
#   This is a PRIVATE GitHub repo pinned to a commit. `npm install` therefore needs:
#     (1) git available in the builder image  -> we `apt-get install -y git` below.
#     (2) read access to the private repo at build time. Two supported paths:
#         a) BuildKit secret (recommended): a GitHub PAT/token with `repo` scope passed as a
#            build secret, used to rewrite the git URL to an authenticated HTTPS clone. NEVER
#            bake the token into a layer.  Build with:
#              DOCKER_BUILDKIT=1 docker build --secret id=gh_token,env=GH_TOKEN -t repid-engine:portable .
#         b) Vendor the dep: pre-install `@hyperdag/proof-verifier` and commit it under a vendored
#            path, or publish it to a private npm registry, removing the build-time git auth need.
#   On Fly: `flyctl deploy --build-secret gh_token=<token>` [SEAN]. On Coolify: set a build secret.
#   If the repo is made PUBLIC, the token is unnecessary and a plain `git`-enabled build resolves it.

# ---------- builder ----------
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# git is required to resolve the github:-pinned @hyperdag/proof-verifier dependency.
# ca-certificates so HTTPS git clones validate.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Copy manifests first for layer caching. (No package-lock copy requirement: install uses
# --legacy-peer-deps to match nixpacks.toml; lockfile is copied if present for reproducibility.)
COPY package.json package-lock.json* ./

# Install deps. The git-pinned private dep needs auth: BuildKit secret `gh_token` is mounted
# only for this RUN (never persisted to a layer). If the secret is absent and the repo is public,
# the plain git clone still succeeds. If absent and the repo is private, this step fails LOUDLY
# (correct — surfaces the missing-auth condition rather than shipping a broken image).
RUN --mount=type=secret,id=gh_token,required=false sh -c '\
  if [ -f /run/secrets/gh_token ]; then \
    git config --global url."https://x-access-token:$(cat /run/secrets/gh_token)@github.com/".insteadOf "https://github.com/" && \
    git config --global url."https://x-access-token:$(cat /run/secrets/gh_token)@github.com/".insteadOf "git+https://github.com/" ; \
  fi ; \
  npm install --legacy-peer-deps ; \
  git config --global --remove-section url."https://x-access-token:****@github.com/" 2>/dev/null || true'

# Copy source and build (tsc -> dist/)
COPY . .
RUN npm run build

# ---------- runtime ----------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Bring the built app + resolved node_modules + manifest only (no source, no .git, no scratch).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

# Run as the non-root user that the node image already provides.
USER node

# The app binds 0.0.0.0:$PORT (src/index.ts:549). $PORT is supplied by the host (Railway/Fly/Coolify).
# EXPOSE is documentation; default 3000 if $PORT is unset (config.ts default).
EXPOSE 3000

# Production entrypoint (matches package.json "start" and Railway start command).
CMD ["node", "dist/index.js"]
