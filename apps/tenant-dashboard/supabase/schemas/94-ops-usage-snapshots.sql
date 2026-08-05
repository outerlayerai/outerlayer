-- =============================================================================
-- Ops Usage Snapshots Schema
-- =============================================================================
-- Purpose: answer "was this table or index used in the last N days?"
--
-- Why snapshots: the pg_stat_* counters only ever go up. They reset on
--   `pg_stat_reset()`, which wipes the history for everyone else, or on a
--   crash. So a table used heavily two years ago looks the same as one in
--   active use. PG16 has `last_seq_scan` for this, but staging runs 15.
--
--   Capturing the counters on a schedule fixes it. The difference between two
--   captures is real usage over a known window, and nothing else is affected.
--
-- Three ways a delta can mislead you:
--   * RLS policy evaluation counts as reads. Every permission check scans the
--     tables the policy names, so reads alone don't prove a table is used.
--   * Read replicas keep their own counters. Reads served there don't show up.
--   * Rare paths (annual billing, disaster recovery, admin tooling) look dead
--     over any window shorter than their period.
--
--   A zero delta is evidence, not a verdict.
--
-- Why the `ops` schema and not `public`: no tenant data, not part of the app
--   API. Keeps it off PostgREST and out of the generated types, same as the
--   `private` schema.
--
-- Usage (psql as postgres/service_role; these are not on the API):
--
--   -- Capture now, out of band with the monthly cron.
--   SELECT ops.capture_usage_snapshot();
--
--   -- Tables untouched over the last 30 days — the drop-candidate list.
--   SELECT relname, seq_scan_delta, idx_scan_delta, writes_delta, n_live_tup,
--          baseline_at, latest_at
--   FROM ops.table_usage_delta(NOW() - INTERVAL '30 days')
--   WHERE stats_reset_between IS FALSE
--     AND seq_scan_delta = 0 AND idx_scan_delta = 0 AND writes_delta = 0
--   ORDER BY relname;
--
--   -- Indexes never scanned over the window, largest first.
--   SELECT relname, indexrelname, pg_size_pretty(index_bytes) AS size
--   FROM ops.index_usage_delta(NOW() - INTERVAL '30 days')
--   WHERE stats_reset_between IS FALSE AND idx_scan_delta = 0
--   ORDER BY index_bytes DESC;
--
-- `baseline_at` is in the result on purpose: read it before concluding
-- anything. An empty result means fewer than two captures exist, NOT that
-- nothing was used.
--
-- Dependencies: none (reads only pg_catalog stat views).
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS ops;

COMMENT ON SCHEMA ops IS 'Operational telemetry about the database itself. No tenant data; not exposed over PostgREST.';

-- -----------------------------------------------------------------------------
-- Table usage snapshots
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ops.table_usage_snapshot (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    schemaname  TEXT   NOT NULL,
    relname     TEXT   NOT NULL,
    seq_scan    BIGINT NOT NULL,
    idx_scan    BIGINT,
    n_tup_ins   BIGINT NOT NULL,
    n_tup_upd   BIGINT NOT NULL,
    n_tup_del   BIGINT NOT NULL,
    n_live_tup  BIGINT NOT NULL,
    -- A reset between two captures makes the later counters smaller, so
    -- subtracting gives a negative number. Recording the epoch lets the
    -- comparison refuse to subtract across a reset.
    stats_reset TIMESTAMPTZ
);

COMMENT ON TABLE ops.table_usage_snapshot IS 'Periodic capture of pg_stat_user_tables counters. Two captures differenced give real usage over a known window.';
COMMENT ON COLUMN ops.table_usage_snapshot.stats_reset IS 'Stats epoch start from pg_stat_database. Counters are only comparable within one epoch.';

-- One row per table per capture. Also the index the comparison query reads by.
CREATE UNIQUE INDEX IF NOT EXISTS table_usage_snapshot_capture_rel_uniq
    ON ops.table_usage_snapshot (captured_at, schemaname, relname);

-- -----------------------------------------------------------------------------
-- Index usage snapshots
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ops.index_usage_snapshot (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    captured_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    schemaname    TEXT   NOT NULL,
    relname       TEXT   NOT NULL,
    indexrelname  TEXT   NOT NULL,
    idx_scan      BIGINT NOT NULL,
    idx_tup_read  BIGINT NOT NULL,
    idx_tup_fetch BIGINT NOT NULL,
    -- Size is stored here because it's what makes an unused index worth
    -- acting on, and you can't look it up later for a dropped index.
    index_bytes   BIGINT,
    stats_reset   TIMESTAMPTZ
);

COMMENT ON TABLE ops.index_usage_snapshot IS 'Periodic capture of pg_stat_user_indexes counters. Differencing two captures identifies indexes unused over a known window.';

CREATE UNIQUE INDEX IF NOT EXISTS index_usage_snapshot_capture_idx_uniq
    ON ops.index_usage_snapshot (captured_at, schemaname, indexrelname);

-- -----------------------------------------------------------------------------
-- Capture
-- -----------------------------------------------------------------------------

-- Writes one snapshot of both stat views. Every row shares one `captured_at`,
-- so a capture is a single point in time. Per-row timestamps would make "the
-- capture before this one" ambiguous.
--
-- SECURITY DEFINER because this is the only writer of these tables and runs
-- unattended from pg_cron. It takes no arguments and only writes values read
-- from pg_catalog, so there's nothing to inject. EXECUTE is restricted below.
CREATE OR REPLACE FUNCTION ops.capture_usage_snapshot()
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_captured_at TIMESTAMPTZ := NOW();
  v_stats_reset TIMESTAMPTZ;
BEGIN
  SELECT ds.stats_reset INTO v_stats_reset
  FROM pg_catalog.pg_stat_database ds
  WHERE ds.datname = current_database();

  INSERT INTO ops.table_usage_snapshot (
    captured_at, schemaname, relname,
    seq_scan, idx_scan, n_tup_ins, n_tup_upd, n_tup_del, n_live_tup, stats_reset
  )
  SELECT
    v_captured_at, st.schemaname, st.relname,
    st.seq_scan, st.idx_scan, st.n_tup_ins, st.n_tup_upd, st.n_tup_del,
    st.n_live_tup, v_stats_reset
  FROM pg_catalog.pg_stat_user_tables st
  -- Skip `ops` — the capture writes to these tables, so including them would
  -- record its own inserts as activity.
  WHERE st.schemaname NOT IN ('ops', 'pg_catalog', 'information_schema');

  INSERT INTO ops.index_usage_snapshot (
    captured_at, schemaname, relname, indexrelname,
    idx_scan, idx_tup_read, idx_tup_fetch, index_bytes, stats_reset
  )
  SELECT
    v_captured_at, si.schemaname, si.relname, si.indexrelname,
    si.idx_scan, si.idx_tup_read, si.idx_tup_fetch,
    pg_catalog.pg_relation_size(si.indexrelid), v_stats_reset
  FROM pg_catalog.pg_stat_user_indexes si
  WHERE si.schemaname NOT IN ('ops', 'pg_catalog', 'information_schema');

  RETURN v_captured_at;
END;
$function$;

COMMENT ON FUNCTION ops.capture_usage_snapshot() IS 'Captures one snapshot of table + index usage counters. Returns the captured_at stamp shared by every row it wrote.';

-- -----------------------------------------------------------------------------
-- Comparison
-- -----------------------------------------------------------------------------

-- Usage between a baseline capture and the most recent one.
--
-- `p_since` picks the baseline: the newest capture at or before it. So "the
-- last 30 days" is `ops.table_usage_delta(NOW() - INTERVAL '30 days')`.
--
-- If no capture is that old, it uses the oldest one instead of returning
-- nothing. Empty would read as "nothing was used", which is wrong. Every row
-- carries `baseline_at` so you can see the window you actually got.
--
-- Returns no rows when there are fewer than two captures. One capture can't
-- produce a delta, and subtracting it from itself gives zeros that look like
-- a genuinely unused table.
--
-- Deltas come back NULL, not zero, when a stats reset falls between the two
-- captures. Zero would read as "definitely unused".
CREATE OR REPLACE FUNCTION ops.table_usage_delta(p_since timestamp with time zone)
 RETURNS TABLE(schemaname text, relname text, baseline_at timestamp with time zone, latest_at timestamp with time zone, seq_scan_delta bigint, idx_scan_delta bigint, writes_delta bigint, n_live_tup bigint, stats_reset_between boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  WITH bounds AS (
    SELECT
      COALESCE(
        (SELECT MAX(s.captured_at) FROM ops.table_usage_snapshot s
          WHERE s.captured_at <= p_since),
        (SELECT MIN(s.captured_at) FROM ops.table_usage_snapshot s)
      ) AS baseline_at,
      (SELECT MAX(s.captured_at) FROM ops.table_usage_snapshot s) AS latest_at
  ),
  -- Baseline == latest means only one capture exists, or p_since is after it.
  -- No window, so return nothing rather than a false zero.
  usable AS (
    SELECT b.baseline_at, b.latest_at FROM bounds b
    WHERE b.baseline_at IS NOT NULL AND b.baseline_at < b.latest_at
  ),
  baseline AS (
    SELECT s.* FROM ops.table_usage_snapshot s, usable u
    WHERE s.captured_at = u.baseline_at
  ),
  latest AS (
    SELECT s.* FROM ops.table_usage_snapshot s, usable u
    WHERE s.captured_at = u.latest_at
  )
  SELECT
    l.schemaname,
    l.relname,
    b.captured_at,
    l.captured_at,
    CASE WHEN reset_between THEN NULL ELSE l.seq_scan - b.seq_scan END,
    CASE WHEN reset_between THEN NULL ELSE COALESCE(l.idx_scan, 0) - COALESCE(b.idx_scan, 0) END,
    CASE WHEN reset_between THEN NULL
         ELSE (l.n_tup_ins + l.n_tup_upd + l.n_tup_del)
            - (b.n_tup_ins + b.n_tup_upd + b.n_tup_del) END,
    l.n_live_tup,
    reset_between
  FROM latest l
  JOIN baseline b
    ON b.schemaname = l.schemaname AND b.relname = l.relname
  CROSS JOIN LATERAL (
    SELECT l.stats_reset IS DISTINCT FROM b.stats_reset AS reset_between
  ) r
  ORDER BY 1, 2;
$function$;

COMMENT ON FUNCTION ops.table_usage_delta(TIMESTAMPTZ) IS 'Table usage between a baseline capture (newest at or before p_since, else the oldest held) and the newest capture. No rows when fewer than two captures exist; NULL deltas when a stats reset falls between them. Always read baseline_at for the real window.';

CREATE OR REPLACE FUNCTION ops.index_usage_delta(p_since timestamp with time zone)
 RETURNS TABLE(schemaname text, relname text, indexrelname text, baseline_at timestamp with time zone, latest_at timestamp with time zone, idx_scan_delta bigint, index_bytes bigint, stats_reset_between boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  WITH bounds AS (
    SELECT
      COALESCE(
        (SELECT MAX(s.captured_at) FROM ops.index_usage_snapshot s
          WHERE s.captured_at <= p_since),
        (SELECT MIN(s.captured_at) FROM ops.index_usage_snapshot s)
      ) AS baseline_at,
      (SELECT MAX(s.captured_at) FROM ops.index_usage_snapshot s) AS latest_at
  ),
  usable AS (
    SELECT b.baseline_at, b.latest_at FROM bounds b
    WHERE b.baseline_at IS NOT NULL AND b.baseline_at < b.latest_at
  ),
  baseline AS (
    SELECT s.* FROM ops.index_usage_snapshot s, usable u
    WHERE s.captured_at = u.baseline_at
  ),
  latest AS (
    SELECT s.* FROM ops.index_usage_snapshot s, usable u
    WHERE s.captured_at = u.latest_at
  )
  SELECT
    l.schemaname,
    l.relname,
    l.indexrelname,
    b.captured_at,
    l.captured_at,
    CASE WHEN reset_between THEN NULL ELSE l.idx_scan - b.idx_scan END,
    l.index_bytes,
    reset_between
  FROM latest l
  JOIN baseline b
    ON b.schemaname = l.schemaname AND b.indexrelname = l.indexrelname
  CROSS JOIN LATERAL (
    SELECT l.stats_reset IS DISTINCT FROM b.stats_reset AS reset_between
  ) r
  ORDER BY 1, 2, 3;
$function$;

COMMENT ON FUNCTION ops.index_usage_delta(TIMESTAMPTZ) IS 'Index usage between a baseline capture (newest at or before p_since, else the oldest held) and the newest capture. No rows when fewer than two captures exist; NULL deltas when a stats reset falls between them. Always read baseline_at for the real window.';

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

-- Reached over psql or service-role, never the API. No anon/authenticated
-- grants, so this stays private even if the schema is exposed by mistake.
REVOKE ALL ON FUNCTION ops.capture_usage_snapshot() FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.table_usage_delta(TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.index_usage_delta(TIMESTAMPTZ) FROM PUBLIC;

GRANT USAGE ON SCHEMA ops TO postgres, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA ops TO postgres, service_role;
GRANT EXECUTE ON FUNCTION ops.capture_usage_snapshot() TO postgres, service_role;
GRANT EXECUTE ON FUNCTION ops.table_usage_delta(TIMESTAMPTZ) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION ops.index_usage_delta(TIMESTAMPTZ) TO postgres, service_role;
