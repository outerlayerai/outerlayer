# Members — Acceptance Criteria

Invitation lifecycle: who may invite whom into what role, a pending
invitation's states, acceptance turning a pending membership into an active
one, and what the members list shows. Member removal, the last-owner rule,
and the built-in permission gate on member-lifecycle actions are covered by
[065-org-lifecycle](065-org-lifecycle.md) and
[075-access-control](075-access-control.md); this document does not
re-state them.

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

## Inviting a member

1. `AC-077-01` **Given** a caller who does not hold the owner role, **When** they invite a new member with the owner role, **Then** the invite is rejected — only owners may invite another member as an owner.
2. `AC-077-02` **Given** an invite names a specific built-in role, **When** the invite is created, **Then** that role is the one recorded on the resulting membership.
3. `AC-077-03` **Given** a tenant's active-plus-pending member count is already at its plan's seat entitlement, **When** a new invite is attempted, **Then** it is denied as an entitlement limit, naming the feature and the tier required to raise it.
4. `AC-077-04` **Given** an email address that already has an active membership in the tenant, **When** an invite is sent to that address, **Then** the invite is rejected as already a member.
5. `AC-077-05` **Given** an invite also specifies a custom role, **When** the invite succeeds, **Then** the custom role is assigned to the new membership only after verifying it belongs to the inviting tenant.

## Pending invitations

6. `AC-077-06` **Given** a pending invitation, **When** an owner resends it, **Then** a fresh invite email goes out and the invitation's expiry is extended.
7. `AC-077-07` **Given** a member who has been invited but has not yet accepted, **When** an owner changes their role, **Then** the change applies to the pending membership the same way it would to an active one.
8. `AC-077-08` **Given** a member who has been invited but has not yet accepted, **When** an owner removes them, **Then** the pending membership is deleted.
9. `AC-077-09` **Given** creating a brand-new invited user's membership fails after their auth account was already provisioned, **When** the failure occurs, **Then** the orphaned auth account is cleaned up rather than left stranded.

## Accepting an invitation

10. `AC-077-10` **Given** a pending invitation the invitee has not yet acted on, **When** they accept it, **Then** their membership flips from pending to active and they gain access to the organization.
11. `AC-077-11` **Given** an invitation that has already been accepted, **When** the invitee tries to accept it again, **Then** the attempt is refused as already a member.
12. `AC-077-12` **Given** an invitation past its expiry, **When** the invitee tries to accept it, **Then** the attempt is refused as expired.
13. `AC-077-13` **Given** an invitee who already belongs to 10 organizations, **When** they try to accept a new invitation, **Then** the acceptance is refused until they leave one.

## Declining an invitation

15. `AC-077-15` **Given** a pending invitation, **When** the invited user declines it, **Then** the pending membership is removed and the invite can no longer be accepted; only the invitee may decline it.

## Members list

14. `AC-077-14` **Given** a tenant's members list is read, **When** a membership has been disabled, **Then** that member does not appear in the list — only active and pending memberships are shown.
