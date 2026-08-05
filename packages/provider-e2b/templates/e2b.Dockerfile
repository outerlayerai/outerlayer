# Reference (CLI) form of the `outerlayer-agent` E2B template — the toolchain
# base every eval env snapshots FROM. Mirrors the LocalDocker
# `outerlayer-agent:py312` image. Build with either:
#   e2b template build --name outerlayer-agent --cpu-count 2 --memory-mb 2048
# or programmatically via build-template.mjs (API-key auth, no CLI login).
FROM python:3.12

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl wget ca-certificates gnupg \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Coding-agent CLIs. codex is best-effort (claude-code is the guaranteed launcher).
RUN npm install -g @anthropic-ai/claude-code@latest \
    && (npm install -g @openai/codex || echo "WARN: @openai/codex install failed")

RUN pip install --no-cache-dir pytest==8.3.3
