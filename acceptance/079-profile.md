# Profile — Acceptance Criteria

Editing one's own profile, and how a change to the auth email address
propagates through confirmation and into the profile record.

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

## Editing profile fields

1. **Given** a user changes their display name or avatar on the profile form, **When** they save, **Then** the profile updates immediately with no confirmation step required.
2. **Given** a user submits a new email address on their profile form, **When** the change is submitted, **Then** it does not take effect immediately — a confirmation flow is triggered and the displayed email reverts to the current address until confirmed.

## Email-change confirmation

3. `AC-079-03` **Given** a user completes the email-confirmation link successfully, **When** they land back on their profile, **Then** they see a confirmation success message.
4. `AC-079-04` **Given** a user clicks an expired email-confirmation link, **When** they land back on their profile, **Then** they see an expired-link message.
5. `AC-079-05` **Given** a user clicks an already-used email-confirmation link, **When** they land back on their profile, **Then** they see an already-used message.

## Auth-email synchronization

6. `AC-079-06` **Given** a user's auth email address changes, **When** the change is applied, **Then** their profile's stored email is synchronized to match, but only when the email itself changed — other auth-field updates leave the stored profile email untouched.
