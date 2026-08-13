# AI Cost — Acceptance Criteria

AI cost tracking shown in the dashboard: per-model/provider pricing
correctness, the seat-based cost estimate tenants configure, and how usage
is attributed to a cost.

Each criterion below carries a stable id. The test that proves a criterion
cites its id in a comment above the test, and
`scripts/ci/check-acceptance-coverage.mjs` enforces the join in both
directions — a criterion no test proves fails the build, and so does a test
citing a criterion that no longer exists.

Ids are written, never derived from position: a positional id silently
re-points at a different criterion the moment a scenario is inserted or
reordered, and the test keeps passing while proving the wrong thing. Never
renumber an id. Retire one by deleting the line and the citation together.

## Pricing correctness per model and provider

1. `AC-070-01` **Given** a usage record with input, output, cache-read, and cache-write tokens, **When** its cost is computed, **Then** each token class is charged at its own rate rather than one blended rate.
2. `AC-070-02` **Given** a model with no published cache pricing, **When** its cost is computed, **Then** cache tokens price at zero rather than silently inheriting the input rate.
3. `AC-070-03` **Given** a reported model id carries a provider prefix, a fine-tune wrapper, a region prefix, or a dated/versioned suffix, **When** its price is resolved, **Then** it matches the underlying base model's price rather than pricing at zero.
4. `AC-070-04` **Given** a pricing override exists for a model id, **When** the price map is built, **Then** the override replaces the base registry entry for that id.
5. `AC-070-05` **Given** the live pricing registry cannot be read or returns a malformed document, **When** pricing refreshes, **Then** the previously bundled or cached price map is kept rather than replaced with an empty or zero-priced map.

## Attribution to sessions

1. `AC-070-11` **Given** a coding-agent session whose turns span more than one model, **When** the session's total cost is computed, **Then** each turn is priced individually and turn-level costs are rescaled so they still sum to the session's authoritative total.

## Org-level AI cost configuration

1. `AC-070-06` **Given** a tenant has never configured its AI-cost inputs, **When** the AI-costs settings page loads, **Then** it shows the unconfigured state rather than an error.
2. `AC-070-07` **Given** an actor updates the tenant's seat count and cost-per-seat inputs, **When** the update is submitted, **Then** the stored values are non-negative, the seat count is a whole number, and the saved config reflects exactly what was submitted.
3. `AC-070-08` **Given** an actor lacking permission to update AI-cost configuration, **When** they submit a change, **Then** the write is denied and no config is persisted.
4. `AC-070-09` **Given** a member of one tenant, **When** they read or write AI-cost configuration, **Then** it is scoped strictly to their own tenant, even if the request carries a different tenant id.
5. `AC-070-10` **Given** the stored cost fields come back from the database as numeric strings, **When** the config is read, **Then** they are coerced to numbers rather than treated as text.
