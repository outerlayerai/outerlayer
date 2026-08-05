# Trace Topics — Acceptance Criteria

Automatic trace classification (facets) and clustering (topics).

Each criterion below carries a stable id. The test that proves a criterion
cites its id in a comment above the test, and
`scripts/ci/check-acceptance-coverage.mjs` enforces the join in both
directions — a criterion no test proves fails the build, and so does a test
citing a criterion that no longer exists.

Ids are written, never derived from position: a positional id silently
re-points at a different criterion the moment a scenario is inserted or
reordered, and the test keeps passing while proving the wrong thing. Never
renumber an id. Retire one by deleting the line and the citation together.

## Facet classification on production traces

1. `AC-056-01` **Given** a new trace lands in a project with Topics enabled, **When** the facet pipeline runs, **Then** the trace carries a short summary for each enabled facet, visible in span details.
2. `AC-056-02` **Given** facet summaries exist on traces, **When** a user filters logs by a facet value, **Then** only matching traces are returned.
3. `AC-056-03` **Given** a trace exceeds the preprocessing token cap, **When** it is preprocessed, **Then** it is truncated to the cap (default 128K tokens, attachments/metrics stripped) before the facet model sees it.

## Topic clustering from facet summaries

1. `AC-056-04` **Given** at least 100 facet summaries exist for a facet, **When** a clustering run is triggered (scheduled or on-demand), **Then** named topics are generated and written back to member traces.
2. `AC-056-05` **Given** topics exist, **When** a user opens the Topics view, **Then** they see clusters sized by trace count with human-readable names.
3. `AC-056-06` **Given** a clustering run produces noise points (HDBSCAN outliers), **When** results are written, **Then** unclustered traces are surfaced as outliers rather than force-assigned.

## Custom facets

1. `AC-056-07` **Given** a user defines a custom facet prompt, **When** the facet pipeline runs, **Then** traces are summarized along that custom lens alongside the built-in facets.
