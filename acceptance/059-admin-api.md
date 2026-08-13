# Admin API for Org Members and Roles — Acceptance Criteria

An org-scoped REST API under `/api/orgs/{orgName}/…` for managing members,
invites, and roles, callable either with a signed-in session or an org-scoped
admin API key (`Authorization: Bearer olk_…`). Admin API keys are minted,
listed, and revoked from org settings; a key's effective permissions are its
own grants intersected with its creator's current role, so a creator's
demotion narrows the key immediately with no separate revocation step.
Enterprise-gated custom-role and per-app role-assignment endpoints reuse the
same audited actions the settings UI calls, so an unlicensed caller gets a
structured `403 entitlement_denied` rather than executing the mutation.

Each criterion below carries a stable id. The test that proves a criterion
cites its id in a comment above the test, and
`scripts/ci/check-acceptance-coverage.mjs` enforces the join in both
directions — a criterion no test proves fails the build, and so does a test
citing a criterion that no longer exists.

Ids are written, never derived from position: a positional id silently
re-points at a different criterion the moment a scenario is inserted or
reordered, and the test keeps passing while proving the wrong thing. Never
renumber an id. Retire one by deleting the line and the citation together.

## Member management REST routes

1. `AC-059-01` **Given** a caller holding `membership.read`, **When** they call `GET /members`, **Then** the response lists both active members and pending invites for the request tenant.
2. `AC-059-02` **Given** a caller lacking `membership.read`, **When** they call `GET /members`, **Then** the request is denied with 403 and no member data is read.
3. `AC-059-03` **Given** a caller holding `membership.insert`, **When** they call `POST /members/invites` with a valid name/email/role, **Then** an invite is sent and the response echoes the new membership id.
4. `AC-059-04` **Given** a caller lacking `membership.insert`, **When** they call `POST /members/invites`, **Then** the request is denied with 403 and no invite is sent.
5. `AC-059-05` **Given** a caller holding `membership.insert` and a pending invite's membership id, **When** they call `POST /members/invites/{inviteId}/resend`, **Then** the invite email is resent to that pending member.
6. `AC-059-06` **Given** an id that does not name a pending invite, **When** `POST /members/invites/{inviteId}/resend` is called, **Then** the response is 404 and no email is resent.
7. `AC-059-07` **Given** a caller holding `membership.update`, **When** they call `PATCH /members/{userId}` with a new role, **Then** the target member's role is changed to the requested role.
8. `AC-059-08` **Given** a caller lacking `membership.update`, **When** they call `PATCH /members/{userId}`, **Then** the request is denied with 403 and no role change is made.
9. `AC-059-09` **Given** a caller holding `membership.delete`, **When** they call `DELETE /members/{userId}`, **Then** the target member is removed from the organization.
10. `AC-059-10` **Given** a caller lacking `membership.delete`, **When** they call `DELETE /members/{userId}`, **Then** the request is denied with 403 and no member is removed.
11. `AC-059-11` **Given** any authenticated org member, **When** they call `GET /roles`, **Then** the response lists the built-in role catalog with no additional permission gate.

## Entitlement denial on invite

12. `AC-059-12` **Given** an org that has hit its plan's member-count entitlement, **When** a caller with `membership.insert` calls `POST /members/invites`, **Then** the response is a structured `403` carrying the `entitlement_denied` code and an upgrade payload describing the required tier, rather than a generic business-rule `400`.

## Admin API key lifecycle

13. `AC-059-13` **Given** a caller holding `admin_api_key.insert` requesting a grant set they fully hold themselves, **When** they mint a key, **Then** the key is created with exactly the requested grants and the plaintext secret is returned in that one response only.
14. `AC-059-14` **Given** a caller holding `admin_api_key.insert` requesting a permission they do NOT themselves hold, **When** they mint a key, **Then** the mint is rejected naming the ungranted permission, and no key is written.
15. `AC-059-15` **Given** an org with existing admin API keys, **When** a caller lists them, **Then** the keys are returned newest first with no digest or other secret material exposed.
16. `AC-059-16` **Given** a caller holding `admin_api_key.delete` and an active key's id, **When** they revoke it, **Then** the key's `revoked_at` is stamped and revoking it again fails rather than silently no-oping.

## Bearer auth security model

17. `AC-059-17` **Given** a live admin API key minted for org A, **When** it is presented as a bearer token against org B's member routes, **Then** the request is denied with 403 and no cross-org data is read.
18. `AC-059-18` **Given** a bearer token that is expired, revoked, or malformed, **When** it is presented to a member route, **Then** the request is denied with 401 and never falls through to session auth.
19. `AC-059-19` **Given** an admin API key whose creator is no longer an active member of the key's org, **When** the key is presented as a bearer token, **Then** the request is denied with 403.
20. `AC-059-20` **Given** an admin API key's creator is demoted to a role that no longer holds some of the key's minted grants, **When** the key is used, **Then** its effective permissions are the intersection of the key's own grants and the creator's current role permissions, not the grants as originally minted.
21. `AC-059-21` **Given** a deployment with `ADMIN_API_KEY_PEPPER` unset, **When** a client presents any well-formed admin API key bearer token, **Then** the token is rejected as invalid without any database lookup, and minting a new key fails with a clear configuration error — while session auth and every other feature remain unaffected.

## EE custom roles and app-member-role assignment

22. `AC-059-22` **Given** a tenant without the `custom_roles` entitlement, **When** a caller with `custom_role.insert` calls `POST /custom-roles`, **Then** the response is a structured `403` with the `entitlement_denied` reason, and no role is created.
23. `AC-059-23` **Given** a tenant without the `custom_roles` entitlement, **When** a caller with `custom_role.update` calls `PATCH /custom-roles/{roleId}`, **Then** the response is a structured `403` with the `entitlement_denied` reason, and no role is changed — the same audited entitlement gate the settings UI uses.
24. `AC-059-24` **Given** a tenant without the `app_level_roles` entitlement, **When** a caller assigns a per-app role via `POST /apps/{appId}/member-roles`, **Then** the response is a structured `403` with the `entitlement_denied` reason, and no assignment is made.
