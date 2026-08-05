# Self-host gateway image. Build context is the REPO ROOT, not this directory:
#   docker build -f apps/gateway-node/Dockerfile .
#
# The build stage installs the whole workspace because `gateway-node`'s esbuild
# bundle pulls the `dist/` of ~a dozen workspace packages, and those packages are
# only resolvable from a complete install. The runtime stage carries none of it:
# esbuild inlines the entire graph into one self-contained ESM file, so the final
# image is a bare Node runtime plus `dist/index.mjs`.

FROM node:22-slim AS build

WORKDIR /app

# Yarn 4 ships in-repo (.yarn/releases) and is selected by packageManager.
RUN corepack enable

COPY . .

# --immutable: the lockfile is authoritative; a build that would need to change
# it is a build against an inconsistent tree, and should fail loudly here.
RUN yarn install --immutable

# The bundle consumes workspace packages as built CJS, so the packages must be
# built before gateway-node's own build step.
RUN yarn turbo build --filter='{./packages/*}' \
    && yarn workspace gateway-node build


FROM node:22-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=9001

COPY --from=build /app/apps/gateway-node/dist/index.mjs ./dist/index.mjs

# The gateway only reads dist/ and listens on an unprivileged port, so nothing
# needs root; a compromised process gets the stock `node` user instead.
USER node

EXPOSE 9001

# The gateway installs SIGTERM/SIGINT handlers that drain in-flight requests,
# so it must be PID 1's actual process — exec form, no shell wrapper.
CMD ["node", "dist/index.mjs"]
