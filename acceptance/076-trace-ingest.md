# Trace Ingest — Acceptance Criteria

The gateway's session/trace ingest pipeline: the trust guarantees a tenant
gets when a coding-agent session or an OTLP trace is synced to the gateway
and converted into stored rows.

Each criterion below carries a stable id. The test that proves a criterion
cites its id in a comment above the test, and
`scripts/ci/check-acceptance-coverage.mjs` enforces the join in both
directions — a criterion no test proves fails the build, and so does a test
citing a criterion that no longer exists.

Ids are written, never derived from position: a positional id silently
re-points at a different criterion the moment a scenario is inserted or
reordered, and the test keeps passing while proving the wrong thing. Never
renumber an id. Retire one by deleting the line and the citation together.

Scenarios without an id are not yet proven by a test; they are tracked debt,
not requirements to skip.

## Capture landing

1. `AC-076-01` **Given** a client syncs a valid agent session, **When** the gateway ingests it, **Then** span rows and a summary row are written, attributed to the calling tenant/actor and clamped to the tenant's capture tier, and the sync is acknowledged only once the insert is durable.

## Capture-tier enforcement (client lies, server truncates)

2. `AC-076-02` **Given** a client declares a capture tier higher than the tenant's entitled tier, **When** the session is converted, **Then** the effective tier is the lower of the two and the stored rows contain zero fields above that tier — the client's declared tier is never trusted on its own.

## Secret and home-path scrubbing (before storage, every tier)

3. `AC-076-03` **Given** a session's tool output or hook data contains a secret (e.g. an AWS key, a provider API key), **When** the session is converted, **Then** the secret is scrubbed before any row is written, at every capture tier including `full`.
4. `AC-076-04` **Given** a session's tool output or file paths contain a user's home directory, **When** the session is converted, **Then** the OS-specific home prefix is replaced with `~` and no username-bearing path survives at rest.

## Span and content caps

5. `AC-076-05` **Given** a session carries more capped-content entries than the server allows (hook entries per event, PR links, commit shas) or a single text field exceeds its length ceiling, **When** the session is converted, **Then** the excess entries are dropped and the field is truncated rather than stored in full.
6. `AC-076-06` **Given** a sync request's total payload or an individual blob exceeds its byte ceiling, **When** the gateway receives it, **Then** the oversized request is rejected (413 for the whole request, a structured per-blob rejection for an oversized blob) before it is written.
7. `AC-076-07` **Given** a tenant has exceeded its monthly span/unit ingest limit, **When** it syncs another session, **Then** the gateway rejects the sync with `span_limit_exceeded` and writes nothing, while a tenant on an unlimited tier is never rejected regardless of volume.

## Retention

8. `AC-076-08` **Given** rows in a swept table are older than a tenant's retention window, **When** the retention sweep runs, **Then** those rows are deleted while rows inside the window, and rows belonging to a tenant with an unlimited or unset retention window, are preserved.
9. `AC-076-09` **Given** two tenants have different retention windows, **When** the retention sweep runs, **Then** each tenant's rows are evaluated against its own cutoff, not a single shared cutoff applied to everyone.

## Idempotent re-sync

10. `AC-076-10` **Given** the same session is converted twice (e.g. a client re-syncs after a dropped ack), **When** the rows are compared, **Then** they are byte-identical — ids are deterministic, so a re-sync re-inserts the same rows rather than duplicating or diverging.

## Storage cap

11. `AC-076-11` **Given** a hobby-tier tenant has exceeded its monthly storage cap, or an admin override sets a lower effective cap that is reached, **When** it syncs another session, **Then** the gateway refuses the sync with `storage_cap_exceeded` and writes nothing.
12. `AC-076-12` **Given** the storage-cap check itself fails (e.g. the Stripe usage-meter call errors), **When** a session is synced, **Then** ingest proceeds — the cap fails open and never becomes an ingest outage.
