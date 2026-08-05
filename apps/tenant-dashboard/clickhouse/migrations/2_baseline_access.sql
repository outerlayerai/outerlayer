-- Baseline access entities: the analytics roles, tenant-isolation row
-- policies, query guardrails profile, and grants. Users are provisioned
-- separately (ensure-read-user.mjs / ensure-write-user.mjs) — only
-- migration-owned entities live here.

CREATE ROLE analytics_readonly;
CREATE ROLE analytics_writer;
CREATE SETTINGS PROFILE `app_query_guardrails` SETTINGS max_memory_usage = 3500000000, max_bytes_before_external_group_by = 1000000000, max_bytes_before_external_sort = 1000000000 TO analytics_readonly, default;
CREATE ROW POLICY tenant_isolation ON otel_traces FOR SELECT USING TenantId = getSetting('SQL_tenant_id') TO analytics_readonly;
CREATE ROW POLICY tenant_isolation_blobs ON agent_blobs FOR SELECT USING TenantId = getSetting('SQL_tenant_id') TO analytics_readonly;
CREATE ROW POLICY tenant_isolation_facets ON trace_facets FOR SELECT USING TenantId = getSetting('SQL_tenant_id') TO analytics_readonly;
CREATE ROW POLICY tenant_isolation_mcp_tool_use ON mcp_tool_use FOR SELECT USING TenantId = getSetting('SQL_tenant_id') TO analytics_readonly;
CREATE ROW POLICY tenant_isolation_scores ON scores FOR SELECT USING TenantId = getSetting('SQL_tenant_id') TO analytics_readonly;
CREATE ROW POLICY tenant_isolation_sessions ON agent_session_summary FOR SELECT USING TenantId = getSetting('SQL_tenant_id') TO analytics_readonly;
CREATE ROW POLICY tenant_isolation_skill_activation ON skill_activation_by_day FOR SELECT USING TenantId = getSetting('SQL_tenant_id') TO analytics_readonly;
CREATE ROW POLICY tenant_isolation_skill_activation_sessions ON skill_activation_sessions FOR SELECT USING TenantId = getSetting('SQL_tenant_id') TO analytics_readonly;
CREATE ROW POLICY tenant_isolation_topic_maps ON trace_topic_maps FOR SELECT USING TenantId = getSetting('SQL_tenant_id') TO analytics_readonly;
CREATE ROW POLICY tenant_isolation_trace_ts ON otel_traces_trace_id_ts FOR SELECT USING TenantId = getSetting('SQL_tenant_id') TO analytics_readonly;
GRANT SELECT ON agent_blobs TO analytics_readonly;
GRANT SELECT ON agent_session_summary TO analytics_readonly;
GRANT SELECT ON mcp_tool_use TO analytics_readonly;
GRANT SELECT ON otel_traces TO analytics_readonly;
GRANT SELECT ON otel_traces_trace_id_ts TO analytics_readonly;
GRANT SELECT ON scores TO analytics_readonly;
GRANT SELECT ON skill_activation_by_day TO analytics_readonly;
GRANT SELECT ON skill_activation_sessions TO analytics_readonly;
GRANT SELECT ON trace_facets TO analytics_readonly;
GRANT SELECT ON trace_topic_maps TO analytics_readonly;
GRANT SELECT, INSERT, ALTER UPDATE, ALTER DELETE ON * TO analytics_writer;
GRANT SELECT ON system.mutations TO analytics_writer;
