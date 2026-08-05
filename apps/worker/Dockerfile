# Single stage — copies pre-built dist from local build.
# Run `yarn build` before `flyctl deploy --build-only --push`.
FROM node:22-slim

WORKDIR /app

# Toolchain for coding agents: git (clone + diff), curl/ca-certificates,
# python3 + python-is-python3 + pipx (common tenant runtimes), build-essential
# for native npm modules. Node 22 base already provides node/npm/npx.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates python3 python3-venv python-is-python3 build-essential \
    && rm -rf /var/lib/apt/lists/*

# Pinned agent CLIs. The agent version IS the image version — upgrades are
# image releases, never runtime installs (a tenant repo can't pin/downgrade
# the agent). Codex ships in P2.
RUN npm install -g @anthropic-ai/claude-code@2.1.202

# Runtime deps only (no devDependencies, no workspace refs) — keeps the image
# small, mirroring apps/builder.
RUN echo '{"type":"module","dependencies":{"dotenv":"^17.3.1","zod":"^4.3.6"}}' > package.json \
    && npm install --omit=dev

# Pre-built runner output.
COPY dist/ ./dist/

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
