# @outerlayer/insights-core

Deterministic, explainable insight detectors over coding-agent sessions —
findings with dollars attached, no LLM required. The same detector set runs
over the local scan and the cloud, both fed from a normalized
`DetectionSession` adapted out of an [`@outerlayer/session-schema`](../session-schema)
`AgentSession`.

## What's here

- **Detectors** — `editRetryLoop`, `toolErrorCluster`, `costOutlier`,
  `apiErrorStall`, `contextChurn`, each pure over a session's turns/tool calls
  and a `ResolvedConfig` of thresholds and cost baselines.
- **`runDetectors` / `rankFindings`** — run the full `DETECTORS` set over a
  batch of sessions and rank the resulting `Finding[]` by severity.
- **`resolveConfig` / `computeBaselines`** — derive cost-outlier and
  cache-read baselines from the session batch itself when the caller doesn't
  supply its own.
- **Weekly digest** — `composeDigest` rolls findings into a `WeeklyRollup`;
  `renderDigestEmail` / `renderDigestSlack` render it for each channel.
- **Error clustering** — `clusterErrorSignatures` / `summarizeClusters` group
  recurring tool errors into named themes, optionally LLM-summarized via
  `fetchAnthropicClient` (the only place in this package that touches an LLM).

## Usage

```ts
import { fromAgentSession, runDetectors, rankFindings, DETECTORS } from "@outerlayer/insights-core";

const sessions = agentSessions.map(fromAgentSession);
const findings = rankFindings(runDetectors(DETECTORS, sessions, { dollarsPerHour: 150 }));
```

## License

Apache-2.0 · Copyright 2026 Magu Studios, Inc.
