# Transactional Email — Acceptance Criteria

The rendered contract for the product's transactional email templates
(`packages/transactional`): invite, password reset, signup confirmation,
build failure, role change, org removal, and platform-admin temporary
access. These are the emails the dashboard's email service (`src/lib/
external-services/`) renders and sends via Resend or SMTP, gated by
`resolveEmailConfig`.

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

## Action links are present, absolute, and exact

1. `AC-081-01` **Given** an invite is sent with an absolute origin and a generated invite link, **When** the invite email renders, **Then** the "Join the team" button's href equals the exact invite link passed in.
2. `AC-081-02` **Given** a password reset is requested with an absolute reset link, **When** the reset-password email renders, **Then** the "Reset password" button's href equals the exact link passed in.
3. `AC-081-03` **Given** a signup confirmation is requested with an absolute confirm link, **When** the confirm-signup email renders, **Then** the "Confirm" button's href equals the exact link passed in.
4. `AC-081-04` **Given** a build failure is reported for an app, **When** the build-failure email renders, **Then** the dashboard link's href is the absolute URL composed from the app's origin, org, and app name, and the same href appears on both the button and the footer link.

## No unresolved placeholders

1. `AC-081-05` **Given** the invite email is rendered without an optional company name, **When** the output is inspected, **Then** the literal string "undefined" does not appear anywhere in it.
2. `AC-081-06` **Given** a build failure is reported with optional commit metadata (message, sha, branch) omitted, **When** the build-failure email renders, **Then** none of those fields render as the literal string "undefined".
3. `AC-081-07` **Given** platform-admin temporary access is granted without a reason, **When** the notification email renders, **Then** no "Reason:" label or "undefined" value appears in the output.

## Recipient-facing context appears where the flow promises it

1. `AC-081-08` **Given** a member's role is changed from one role to another, **When** the role-changed email renders, **Then** both the old role and the new role, and the organization name, appear as rendered text.
2. `AC-081-09` **Given** a member is removed from an organization, **When** the removed-from-org email renders, **Then** the organization name appears in both the preview text and the body copy.
3. `AC-081-10` **Given** platform-admin temporary access is granted with an expiry timestamp, **When** the notification email renders, **Then** the expiry appears as a formatted date/time (not the raw ISO string), and the admin email and organization name both appear.
