# Third-Party Integrations — Acceptance Criteria

Environment variables for managed deployments: per-environment and per-kind
scoping, encrypted storage, and the picker UI that targets a write at one or
more scopes at once.

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

## Storage and secrecy

1. `AC-067-01` **Given** an app admin sets an env var's value, **When** it is saved, **Then** the value is stored in the platform's encrypted secret store under a name derived from its scope, and is retrievable back through that same name.
2. `AC-067-02` **Given** env vars are listed for an app or environment, **When** the list renders, **Then** every row carries the key and its metadata only — no row ever carries the secret value.
3. `AC-067-03` **Given** a key already has a stored value for a scope, **When** it is saved again with a new value, **Then** the existing secret is replaced in place rather than deleted and recreated, so a mid-write failure can never leave the key transiently unset.
4. `AC-067-04` **Given** an env var is deleted, **When** the delete completes, **Then** both its row and its stored secret are removed together — the secret is no longer readable under its name.

## Scoping and precedence

5. `AC-067-05` **Given** an env var write targets a specific environment, **When** the write is submitted, **Then** that environment must belong to the app being written to, or the write is refused before any secret is stored.
6. `AC-067-06` **Given** both a kind-targeted row (e.g. "All Environments") and a specific-environment row exist for the same key, **When** a deployment resolves its environment variables, **Then** the specific-environment value wins for that environment.
7. `AC-067-07` **Given** no specific-environment row exists for a key, **When** a deployment in that environment resolves its variables, **Then** it inherits the value from the matching kind-targeted row.
8. `AC-067-08` **Given** a user is choosing targets in the add-variable dialog, **When** they select "All Environments" after having chosen one or more kinds or a single-environment override, **Then** those prior selections are cleared, and selecting a kind or override likewise clears "All Environments" — the picker never saves a conflicting mix of targets.

## Validation

9. `AC-067-09` **Given** a key name that does not match the required uppercase-letters/digits/underscores format, **When** a user attempts to save it, **Then** the save is blocked before any value reaches the server.
10. `AC-067-10` **Given** a key name reserved for the platform's own runtime injection, **When** a user attempts to set it, **Then** the write is refused with a message explaining it is platform-managed.

## Access control

11. `AC-067-11` **Given** a caller without permission to reveal secret values, **When** they invoke the reveal action, **Then** it is denied before any secret is read from storage.
12. `AC-067-12` **Given** a role granted only read access to env vars, **When** it attempts to insert one directly, **Then** the write is refused at the database, even though its read of existing rows succeeds.
