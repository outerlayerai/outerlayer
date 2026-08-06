# @outerlayer/repo-report

The **Repo Report** — the free qualification gate. It answers *"can
OuterLayer evaluate agents on this repo, how well, and what would a card
cost?"* in minutes, **with no agent runs** (cheap → free tier). Qualified
repos proceed to Report Cards that basically never flake; unqualified repos get
a *diagnosis* that is itself valuable and routes to concierge.

It composes the upstream contracts — the mining funnel, the task-validation
report, the env-build report, and the MDE — into a `RepoReport` rendered three
ways: JSON, terminal, and a **self-contained HTML** artifact.

## Why structural inputs

This package's only runtime dependency is `@outerlayer/task-format`. It takes
narrow structural views of the upstream reports (`MiningFunnel`, `EnvSummary`,
`ValidationSummary`, `PowerRow`) rather than importing the miner or the
statistics layer — so the report composes whatever those packages emit, and
the caller (the CLI/qualify layer) wires the real functions in.

```ts
import { buildRepoReport, renderReportHtml, renderReportText } from "@outerlayer/repo-report";

const report = buildRepoReport({ repo, headCommit, stack, mining, env, validation, power, cost });
console.log(renderReportText(report));
await writeFile("report.html", renderReportHtml(report)); // the forwardable artifact
```

## The verdict banner is honest

- **Ready** requires validated tasks ≥ a floor (default 20) **AND** a buildable
  env **AND** a supported stack. Anything less is **Ready with caveats** with
  the specifics stated (`only 12 validated tasks`, `monorepo — scope to one
  package`, `1 env needs setup help`).
- **Not yet** when the stack isn't supported or zero tasks validated — always
  with a *diagnosis and next step* (add tests / waitlist / concierge), never a
  stack trace.

## The supported-stack matrix (v1, published)

Supported: Python/pytest, TypeScript-or-JS/jest|vitest. Partial: monorepos
(per-workspace scoping). Not yet → waitlist/concierge: JVM, Go (fast-follow),
Ruby, mobile, GPU-dependent, hermetic builds (bazel), suites needing live
external services.

## The HTML is an outreach artifact

`renderReportHtml` produces a **self-contained** file — inline styles, no
external assets, no scripts, all interpolation escaped — so it stands alone
when an EM forwards it, having never seen the product. Verified: the render
contains no `src="http…"`/`href="http…"` and escapes repo names.
