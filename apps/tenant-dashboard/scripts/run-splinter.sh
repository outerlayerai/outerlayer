#!/bin/bash
#
# Supabase Splinter Linter
# Runs the official Supabase security & performance linter against the local database.
# See: https://github.com/supabase/splinter
#

set -e

echo "Running Supabase splinter linter for security and performance issues..."
echo "See: https://github.com/supabase/splinter"
echo ""

# Download splinter.sql from Supabase, PINNED to a specific commit.
# Tracking upstream `main` meant any new lint rule shipped upstream became a
# surprise CI failure on unrelated PRs. Pin to a known commit and bump
# SPLINTER_REF deliberately to adopt newer rules.
#
# The pinned revision includes the anon_/authenticated_security_definer_function_executable rules.
# All SECURITY DEFINER functions exposed to anon/authenticated were hardened: the JWT-reading authz helpers moved to the unexposed `private`
# schema (public INVOKER wrappers stay for external RPC callers), and every
# internal/service-role/trigger function had its PUBLIC/anon/authenticated
# EXECUTE grant revoked (96-function-execution-grants.sql).
SPLINTER_REF="${SPLINTER_REF:-90a77b82da50}"
curl -s "https://raw.githubusercontent.com/supabase/splinter/${SPLINTER_REF}/splinter.sql" > /tmp/splinter.sql

# Create a wrapper SQL that runs splinter and filters results
cat > /tmp/run_splinter.sql << 'EOSQL'
SELECT name, level, detail
FROM (
EOSQL

# Skip the SET LOCAL line and append the rest of splinter.sql
tail -n +3 /tmp/splinter.sql >> /tmp/run_splinter.sql

cat >> /tmp/run_splinter.sql << 'EOSQL'
) AS lints
WHERE level IN ('WARN', 'ERROR')
  -- Exclude known acceptable warnings:
  -- 1. extension_in_public for citext - moving requires DROP which cascades and breaks dependent tables
  -- 3. multiple_permissive_policies for sso_* tables - intentional design (tenant-scoped + platform_admin policies)
  AND NOT (name = 'extension_in_public' AND detail LIKE '%citext%')
  AND NOT (name = 'multiple_permissive_policies' AND detail LIKE '%sso_%')
  -- 4. multiple_permissive_policies for annotation_queue - intentional design (service_role_all + per-action policies)
  AND NOT (name = 'multiple_permissive_policies' AND detail LIKE '%annotation_queue%')
  -- 6. multiple_permissive_policies for environment -
  --    intentional design (tenant-scoped read policy + separate platform_admin read policy,
  --    same pattern as sso_* tables above; platform admins get cross-tenant read)
  AND NOT (name = 'multiple_permissive_policies' AND detail LIKE '%public.environment%')
  -- 8. multiple_permissive_policies for deployment -
  --    intentional design: "Enable read access for tenant users" (tenant-scoped) +
  --    "Platform admins can read deployment saga rows" (platform_admin cross-tenant read).
  --    Same 2-policy pattern as environment and sso_* tables; promotion_history was merged
  --    into deployment when the promotion_history table was dropped.
  AND NOT (name = 'multiple_permissive_policies' AND detail LIKE '%public.deployment%')
  -- 7. multiple_permissive_policies for alert - intentional design.
  --    95-gateway-rls.sql adds a gateway-scoped read policy (gateway_tenant_read_alert)
  --    alongside the pre-existing tenant "Enable read access" policy; the gateway role
  --    also inherits the tenant policy. Same pattern as environment / promotion_history.
  AND NOT (name = 'multiple_permissive_policies' AND detail LIKE '%public.alert%')
  -- 9. multiple_permissive_policies for audit_log - intentional design:
  --    service_role_select (internal platform-admin viewer, all rows) + "Members can read
  --    own tenant audit trail" (tenant-scoped, gated by audit_log.read). Same
  --    service_role + specific-policy stack as annotation_queue above.
  AND NOT (name = 'multiple_permissive_policies' AND detail LIKE '%public.audit_log%')
  -- 10. multiple_permissive_policies for membership/profile, role gateway only -
  --    intentional design: 95-gateway-rls.sql's gateway_tenant_read_membership /
  --    gateway_tenant_read_profile stack with the pre-existing "Users can read
  --    memberships" / "Users can read profiles" policies (no TO clause, so PUBLIC,
  --    so the gateway role inherits them too). Those pre-existing policies gate on
  --    auth.uid() matching a real membership.user_id (directly, or via
  --    private.authorize()'s active-membership lookup) — but the gateway Postgres
  --    role only serves API-key/machine callers, whose minted JWT `sub` claim is
  --    the tenant id itself (verify-key.ts's user has no gatewayUserId — "machine
  --    path, no human profile" — so getScopedSupabase's `user.gatewayUserId ??
  --    user.tenantId` fallback fires), never a real auth.users id. auth.uid() can
  --    therefore never match a real membership.user_id for this role, so neither
  --    branch of the pre-existing policies is ever satisfiable under it — the OR
  --    is inert for gateway, not merely tenant-scoped: the ONLY rows the gateway
  --    role ever reads through these tables come from its own new tenant-scoped
  --    policy. This inertness depends on 95-gateway-rls.sql's
  --    `GRANT EXECUTE ON FUNCTION private.authorize TO gateway` — without it,
  --    the pre-existing policies' OR-arm doesn't evaluate to false, it ERRORS
  --    (42501, no EXECUTE privilege) before Postgres ever reaches the
  --    tenant-scoped policy, so the grant is load-bearing for this exclusion,
  --    not just for read correctness. Role-scoped (not table-only, unlike the
  --    alert/environment/deployment entries above) because the live finding is
  --    role-specific — confirmed no other role has a multiple_permissive
  --    finding on these two tables.
  AND NOT (name = 'multiple_permissive_policies' AND detail LIKE '%public.membership%' AND detail LIKE '%gateway%')
  AND NOT (name = 'multiple_permissive_policies' AND detail LIKE '%public.profile%' AND detail LIKE '%gateway%')
  -- 5. pg_graphql_*_table_exposed - the splinter SQL is fetched from upstream main, and the GraphQL-exposure
  --    rules added in mid-2026 flag every public table that grants SELECT to anon/authenticated. Tenant
  --    isolation here is enforced by RLS, not by GraphQL schema visibility — every table in the schema
  --    has explicit RLS policies that scope SELECT by tenant_id() / app_authorize(). Hiding the tables
  --    from GraphQL schema introspection is defense-in-depth at best and would require revoking SELECT
  --    from the roles the dashboard's tenant-scoped client uses. Exclude this rule wholesale rather than
  --    table-by-table, since the answer is the same for every public table (~60+ tables).
  AND NOT (name = 'pg_graphql_anon_table_exposed')
  AND NOT (name = 'pg_graphql_authenticated_table_exposed')
ORDER BY level DESC, name;
EOSQL

# Run via docker exec since psql isn't installed on the runner
# First, find the database container name
echo "Finding Supabase database container..."
DB_CONTAINER=$(docker ps --filter "name=supabase_db" --format "{{.Names}}" | head -1)
echo "Found container: $DB_CONTAINER"

if [ -z "$DB_CONTAINER" ]; then
  echo "Error: Could not find Supabase database container"
  docker ps
  exit 1
fi

RESULTS=$(docker exec -i "$DB_CONTAINER" psql -U postgres -t -f - < /tmp/run_splinter.sql 2>&1)
echo "Raw results:"
echo "$RESULTS"
echo "---"

# Filter out empty results (just whitespace)
FILTERED_RESULTS=$(echo "$RESULTS" | grep -v "^[[:space:]]*$" || true)

if [ -n "$FILTERED_RESULTS" ]; then
  echo "❌ Database linter found issues:"
  echo ""
  echo "$FILTERED_RESULTS"
  echo ""
  echo "Please fix these issues before merging."
  echo "See: https://supabase.com/docs/guides/database/database-linter"
  exit 1
else
  echo "✅ No security or performance issues found (WARN/ERROR level)."
fi
