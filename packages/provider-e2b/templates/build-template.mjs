// Build the `outerlayer-agent` E2B template — the toolchain base every eval env
// snapshots FROM (python/pytest/git/node + the coding-agent CLIs). Programmatic
// build (Build System 2.0) so it authenticates with E2B_API_KEY — no CLI login.
//
//   E2B_API_KEY=e2b_*** node build-template.mjs
//
// Mirrors the LocalDocker `outerlayer-agent:py312` image. codex is best-effort
// (claude-code is the guaranteed launcher today).
import { Template } from "e2b";

const apiKey = process.env.E2B_API_KEY;
if (!apiKey) { console.error("set E2B_API_KEY"); process.exit(1); }
const name = process.env.OUTERLAYER_E2B_TEMPLATE ?? "outerlayer-agent";

// E2B's build runs runCmd as a non-root user by default; the install steps
// need root (apt/npm -g/pip). The verify step can run as the default user.
const asRoot = { user: "root" };
const template = Template()
  .fromImage("python:3.12")
  .runCmd("apt-get update && apt-get install -y --no-install-recommends git curl wget ca-certificates gnupg && rm -rf /var/lib/apt/lists/*", asRoot)
  .runCmd("curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/*", asRoot)
  .runCmd("npm install -g @anthropic-ai/claude-code@latest", asRoot)
  .runCmd("npm install -g @openai/codex || echo 'WARN: @openai/codex install failed — claude-code still available'", asRoot)
  .runCmd("pip install --no-cache-dir pytest==8.3.3", asRoot)
  .runCmd("python --version && pytest --version && git --version && node --version && claude --version && (codex --version || echo 'codex: absent')");

console.log(`building E2B template "${name}" (python/pytest/git/node/claude[/codex])…`);
const info = await Template.build(template, name, {
  apiKey,
  cpuCount: 2,
  memoryMB: 2048,
  onBuildLogs: (l) => process.stdout.write(typeof l === "string" ? l : `${JSON.stringify(l)}\n`),
});
console.log(`\n✅ built template "${name}":`, JSON.stringify(info));
