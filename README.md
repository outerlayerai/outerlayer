<div align="center">

# OuterLayer

### The evidence layer for coding agents.

Open source · agentic engineering

[Website](https://www.outerlayer.ai) · [Docs](https://docs.outerlayer.ai) · [Cloud](https://app.outerlayer.ai)

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](CONTRIBUTING.md)

</div>

You can't watch every agent session, and today watching is the only tool you
have. Outerlayer ties each one to the code it shipped: merged, reverted, what
it cost. Fix the mistakes that keep repeating once, and the numbers show it
worked.

OuterLayer is the open-source platform for coding-agent fleets. It is not
another coding agent, and it does not hand you a thousand sessions of exhibits
to review. It routes your attention: a thousand sessions in, the three things
worth looking at out.

## What it does

- **Captures every session.** The `outerlayer` CLI hooks into the session
  files your coding agents already write to disk (Claude Code, Codex CLI,
  Cursor). Capture is local and passive; nothing uploads until you run
  `outerlayer sync`, and the default redaction tier strips message content
  client-side before anything leaves your machine.
- **Joins sessions to outcomes.** Each session is tied to the pull request it
  produced: merged or reverted, and what it cost. Velocity numbers come with a
  stability guardrail attached, not as a standalone brag.
- **Mines the corrections.** Steering topics cluster the moments a human had
  to step in, so a mistake the fleet keeps repeating surfaces as one topic
  instead of fifty scattered transcripts.
- **Versions context, measures the gain.** Agent context (CLAUDE.md files,
  skills, rules) is mirrored and versioned, and session outcomes joined to
  your own merged PRs measure whether a context fix improved the fleet.
- **Speaks OpenTelemetry.** Point your existing OTLP trace instrumentation at
  the gateway and spans land next to your sessions; no proprietary trace
  format to adopt.

## Getting started

### From your first session

OuterLayer works from the first Claude Code session, no fleet required:

```bash
npx outerlayer init           # install the capture hooks
npx outerlayer sync --dry-run # see exactly what would leave your machine
npx outerlayer sync           # upload to your workspace
```

### Cloud

The fastest path. Sign up at <https://app.outerlayer.ai>, connect your repo,
and run the three commands above.

### Self-hosting

OuterLayer runs on your own machines. The gateway is the same Hono app whether
it is deployed as a Cloudflare Worker or as a plain Node process. See the
[self-hosting guide](docker/README.md) for standing up an instance, and
[`apps/gateway-node/README.md`](apps/gateway-node/README.md) for the gateway
specifically: required configuration, the authentication posture you have to
choose, and what self-hosting does not include. Read that last part before you
point production traffic at it.

### Local development

For working on OuterLayer itself:

```bash
yarn                                            # install (Yarn 4, workspaces)
cp .env.example .env.local
cp apps/tenant-dashboard/.env.example apps/tenant-dashboard/.env.local
cp apps/gateway/.dev.vars.example apps/gateway/.dev.vars
cd apps/tenant-dashboard && npx supabase start  # database + auth
npx supabase migration up                       # bring the schema up to date
cd ../.. && yarn dev
```

You need Node 22+ and Docker. The env templates need real values filled in
before anything boots; `npx supabase status -o json` prints most of them.
[CONTRIBUTING.md](CONTRIBUTING.md) has the full sequence, including ClickHouse
for the analytics and trace surfaces, and the two settings
(`BILLING_ENABLED=false`, `SKIP_ENV_VALIDATION=true`) that keep a contributor
from needing Stripe credentials.

## Autonomy is earned, not declared

Handing a fleet more of the work is the goal, and it is a result you build
toward, not a toggle you flip on day one. Every autonomy claim in OuterLayer
is anchored to evidence: sessions joined to PR outcomes, corrections mined
into steering topics, context changes measured against your own history.
When the numbers say the last increase in scope held, you grant the next one.

## Built to be trusted with your sessions

Agent sessions are among the most sensitive telemetry a company has. Three
guarantees hold by architecture, not by policy:

1. **Open source.** The platform and the packages published from this
   repository are Apache-2.0; the code that touches your sessions is
   auditable.
2. **Self-hostable.** Sessions never have to leave your infrastructure.
3. **No per-developer leaderboards, ever.** Enforced in the query layer, not
   promised in a policy document. Dashboards aggregate by branch, repo, model,
   and agent type only. Measure the agents, not the engineers.

## Repository layout

Yarn 4 workspaces driven by Turborepo.

| Path | What lives there |
| --- | --- |
| `apps/tenant-dashboard` | The Next.js dashboard, the bulk of the product |
| `apps/gateway` | The Hono gateway, deployed as a Cloudflare Worker |
| `apps/gateway-node` | The same gateway on a Node process, for self-hosting |
| `apps/worker` | Machine-side runner for cloud workers |
| `apps/e2e`, `apps/integration-tests` | Playwright end-to-end, and cross-service integration tests |
| `packages/` | Shared cores, service layers, API contracts, and tooling (including the `outerlayer` CLI) |
| `docs/` | The committed OpenAPI specs for the gateway and dashboard APIs |
| `ee/`, `apps/tenant-dashboard/ee/` | The enterprise license, and the features under it |

## Open source, and what isn't

OuterLayer is open core.

- **Almost all of this repository is [Apache-2.0](LICENSE)**: the dashboard,
  the gateway, the apps, the packages, and the infrastructure. You can
  self-host it, modify it, redistribute it, and use it commercially, in open
  or closed source, with no copyleft obligation.
- **Directories named `ee` are source-available under a commercial license.**
  You can read them and evaluate them; running them in production needs an
  agreement with Magu Studios, Inc.

[LICENSING.md](LICENSING.md) is the authoritative per-directory map and answers
the common questions: self-hosting, using the published packages in closed
source, and what needs a commercial license.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers setup, branch and commit conventions,
the checks that gate a PR, and what we expect from a test. Bug fixes can go
straight to a PR; for a new feature or an API-contract change, open an issue
first so we can agree on the shape.

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Security

Please don't open a public issue for a vulnerability.
[SECURITY.md](SECURITY.md) has the private reporting channels, what's in and
out of scope, our response targets, and the safe-harbour terms.

## Support

[SUPPORT.md](SUPPORT.md): where to ask questions, and what the open-source
project does and doesn't promise.

## License

Apache-2.0, except for the `ee/` directories, which are source-available under
a commercial license. See [LICENSE](LICENSE) and [LICENSING.md](LICENSING.md).

Copyright Magu Studios, Inc.
