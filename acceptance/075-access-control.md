# Access Control — Acceptance Criteria

Who can do what: built-in tenant roles, custom roles, app-scoped access,
platform admin, cross-tenant isolation, and session/auth basics.

Each criterion below carries a stable id. The test that proves a criterion
cites its id in a comment above the test, and
`scripts/ci/check-acceptance-coverage.mjs` enforces the join in both
directions — a criterion no test proves fails the build, and so does a test
citing a criterion that no longer exists.

Ids are written, never derived from position: a positional id silently
re-points at a different criterion the moment a scenario is inserted or
reordered, and the test keeps passing while proving the wrong thing. Never
renumber an id. Retire one by deleting the line and the citation together.

These criteria state the contract a stakeholder can observe — who can act on
what, and what is guaranteed never to leak. The exhaustive per-permission,
per-role matrix that proves the database enforces this contract for every
combination lives in the structural suites the citations point to
(`authz-equivalence-matrix.test.ts`, `gateway-rls-matrix.test.ts`,
`rbac/rbac-matrix.test.ts`); this document does not re-enumerate that matrix.

## Built-in roles

1. `AC-075-01` **Given** a member's built-in role includes the permission an action requires, **When** they perform that action inside their own org, **Then** it succeeds and the underlying data reflects it; **given** their role does not include that permission, **when** they attempt the same action, **then** it is refused and the data is left unchanged.
2. `AC-075-02` **Given** a member's role is `disabled`, **When** they attempt any tenant action, **Then** every one is refused, regardless of what a non-disabled member in the same org could do.

## Custom roles

3. `AC-075-03` **Given** a tenant assigns a member a custom role, **When** that member acts, **Then** their effective permissions are the custom role's permission set, not their built-in role's.
4. `AC-075-04` **Given** a member's custom role assignment is cleared (removed from the member, or the custom role itself is deleted), **When** they next act, **Then** their access reverts to their stored built-in role.
5. `AC-075-05` **Given** a tenant's billing plan no longer entitles custom roles, **When** the plan changes, **Then** every member's custom role assignment is cleared and each falls back to their own built-in role.

## App-scoped access

6. `AC-075-06` **Given** a member is scoped to specific apps rather than the whole org, **When** they act on an app they are not assigned to, **Then** they have no access to it, even though an unrestricted member with the same role would.

## Cross-tenant isolation

7. `AC-075-07` **Given** any authenticated user, **When** they operate under an organization, **Then** they see and can affect only that organization's data — never another organization's, regardless of their role in either.
8. `AC-075-08` **Given** a user holds different roles in two organizations, **When** they operate under one of them, **Then** their effective role and access follow that organization, never a role or session state carried over from the other.
9. `AC-075-09` **Given** a user has been invited to an organization but has not accepted, **When** they act before accepting, **Then** they have no access to that organization's data.

## Auth and session

10. `AC-075-10` **Given** a user has an active signed-in session, **When** a dashboard request runs on their behalf, **Then** every read and write it performs resolves to that user's own identity and org membership.
11. `AC-075-11` **Given** a member creates or edits another membership's role, **When** the role they assign exceeds what their own permissions allow granting, **Then** the change is refused.

## Platform admin

12. `AC-075-12` **Given** platform administration is a role orthogonal to any tenant role, **When** an account has not been explicitly granted a platform role, **Then** it has no platform-admin access, no matter what tenant role it holds anywhere.
