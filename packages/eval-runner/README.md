# @outerlayer/eval-runner

The run backend: composes the eval loop end to end so a repo's tasks and two
configs turn into a real [`@outerlayer/report-card`](../report-card)
`ReportCard` — from real trial execution, not a synthetic preview.

```
tasks + two configs
  → runMatrix (@outerlayer/trial-harness): each (task × config × trial)
    runs the agent in a sandbox, freezes the patch, grades in a fresh sandbox
  → reportStats (@outerlayer/eval-stats): paired bootstrap, McNemar, Wilson,
    MDE, verdict tier
  → buildReportCard (@outerlayer/report-card): the shareable verdict
```

The provider (LocalDocker / Fly / E2B), launcher (claude-code / codex /
scripted), and env factory are all injected by the caller — orchestration is
identical regardless of what's plugged in underneath.

## Usage

```ts
import { runEvaluation } from "@outerlayer/eval-runner";

const { card, stats, trials, spentUsd } = await runEvaluation(tasks, [configA, configB], {
  repoLabel: "your-org/your-repo",
  trialsPerTask: 3,
  seed: 1,
});
```

Beyond the run loop, this package also carries the cloud eval worker's
supporting seams: a least-privilege `EvalGatewayClient` for the control-plane
job/status/escalation endpoints, trial-result persistence to the gateway
(chunked to server caps), and mapping trial transcripts onto
[`@outerlayer/session-schema`](../session-schema) `AgentSession`s so runs show
up in the sessions UI like any other coding-agent session.

## License

Apache-2.0 · Copyright 2026 Magu Studios, Inc.
