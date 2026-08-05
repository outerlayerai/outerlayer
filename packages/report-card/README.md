# @outerlayer/report-card

The Harness Report Card — the shareable verdict: *"Config A vs Config
B on OUR repo — Δ resolve rate with CIs, $-per-resolved-task, and where it
breaks."* This is the **shared renderer** behind both the dashboard card and
the CLI (`outerlayer eval report --out card.html`) — one source of truth, so
the OSS BYO-key artifact and the hosted card are byte-identical.

## The integrity rules ARE the brand

Enforced in code (`integrity.ts`), on the *rendered output*, so no path can
ship a dishonest card:

- **Verdict tier always visible** (`Clear result` / `Directional` /
  `Underpowered`).
- **MDE line always printed** — "This run can detect differences ≥ Xpp;
  observed |Δ| = Ypp."
- **Never a naked winner** — a card that names a winner without the tier chip
  AND the MDE line throws `CardIntegrityError` (a bug, caught in tests).
- **Underpowered cards render the prescription**, not a winner.
- **Exclusions + sensitivity disclosed** when present.

```ts
import { buildReportCard, renderCardHtml, renderCardText } from "@outerlayer/report-card";

const card = buildReportCard({ repoLabel, stats, taxonomy, divergent, perTask, quarantinedTests });
const html = renderCardHtml(card);  // self-contained; also runs the integrity lint on its own output
```

## All numbers come from eval-stats

The card **never computes statistics** — it takes a structural view of
[`@outerlayer/eval-stats`](../eval-stats)'s `ReportStats` and renders it. One primary metric is headlined (paired
resolve-rate Δ); everything else is labeled secondary/exploratory. This keeps
the stats in exactly one place and the card a pure presentation layer.

## The card contents

Headline (verdict chip + templated one-sentence conclusion carrying N and the
tier) · primary paired Δ resolve rate with 95% CI and per-config Wilson CIs ·
economics ($-per-resolved-task per config + total run cost) · the MDE line ·
where-it-breaks (failure taxonomy split by config from trial statuses and
insight detectors, plus top divergent tasks) · per-task table · disclosures footer
(exclusions, sensitivity, quarantined tests, methodology link, schema stamp).

## Export

`renderCardHtml` is **self-contained** — inline styles, no external assets, no
scripts, all interpolation escaped — so the exported file IS the design-partner
deliverable and the launch content, viewable with no auth when forwarded.
`renderCardText` is the CLI/terminal parity rendering. Both gate on the
integrity lint before returning.

## Scope

This package is the render and integrity core, with CLI parity verified by unit
tests and an HTML export fixture. The dashboard flow that carries a run wizard
through a live trial matrix to a rendered card consumes this renderer and lives
in the application rather than here.
