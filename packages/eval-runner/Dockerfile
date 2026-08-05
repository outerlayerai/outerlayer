# Ephemeral eval-worker image.
# BUILD CONTEXT MUST BE THE REPO ROOT (workspace resolution):
#   fly deploy -c packages/eval-runner/fly.toml \
#     --dockerfile packages/eval-runner/Dockerfile
#
# Installs ONLY the eval-runner workspace + its @outerlayer deps (via
# `yarn workspaces focus`) — NOT the whole monorepo, whose other apps carry
# native-build deps (sdk-python, ssh2/cpu-features) that fail in a slim image and
# blow the builder deadline. Builds the dep-tree with `yarn workspaces foreach`
# (topological), so no turbo needed. Uses E2B for sandboxes → image needs only
# Node, no Docker-in-Docker.
FROM node:22-slim
WORKDIR /app
RUN corepack enable

COPY . .

# Install just the worker's dependency subset from the root lockfile.
RUN yarn workspaces focus @outerlayer/eval-runner

# Build eval-runner + its @outerlayer deps in topological order (each is tsup).
RUN yarn workspaces foreach --recursive --topological --from @outerlayer/eval-runner run build

ENV NODE_ENV=production
ENV OUTERLAYER_E2B_ENABLED=1

# Run-once: reads RUN_ID from env, runs the eval, writes the card, exits.
CMD ["node", "packages/eval-runner/eval-worker.mjs"]
