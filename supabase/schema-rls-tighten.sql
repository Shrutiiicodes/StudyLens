-- ============================================================================
-- Study-Lens — RLS tightening migration
-- ============================================================================
-- Replaces the dev-state `open_all USING (true)` policies with production
-- ownership policies. Run this in the Supabase SQL Editor.
--
-- SAFETY:
--   * NO data is mutated. This script contains no DELETE / DROP TABLE /
--     TRUNCATE / ALTER COLUMN. It only enables RLS and swaps POLICIES.
--   * Idempotent — safe to re-run (drops policies by name before recreating).
--   * Atomic — wrapped in a transaction; if any statement fails, nothing
--     applies and you stay exactly where you were.
--   * Reversible — a one-block rollback to the old open policies is at the
--     bottom of this file (commented out).
--
-- PREREQUISITE (must ship first or alongside):
--   src/lib/question-generator.ts must use the service-role client for its
--   internal spaced-review / weak-spot reads (concepts, mastery, attempts).
--   The patched version does this. Without it, those two features silently
--   return empty once the ownership policies below are active, because the
--   anon client used previously has no session (auth.uid() is null).
--
-- WHY THIS IS SAFE FOR THE APP:
--   Every server route and engine accesses Supabase via the service-role
--   client, which BYPASSES RLS. So all server reads/writes keep working.
--   These policies exist to stop the *public anon key* from reading other
--   users' rows directly over the REST API — the actual hole that
--   `USING (true)` left open.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 0. Make sure RLS is enabled on every table in scope (no-op if already on).
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.profiles                          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.concepts                          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mastery                           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions                          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attempts                          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.misconceptions                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipeline_runs                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.question_exposures                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.question_pool                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.question_irt                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.concept_bkt_params                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.triple_verification_cache         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.misconception_explanation_cache   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learn_content_cache               ENABLE ROW LEVEL SECURITY;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Drop ALL existing policies on the tables in scope.
--    Catches every legacy name: open_all, open_read_cache, open_all_mc_cache,
--    open_all_learn_cache, service_write_cache, etc. — without us having to
--    enumerate them.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
    r RECORD;
    scope text[] := ARRAY[
        'profiles','concepts','mastery','sessions','attempts','misconceptions',
        'pipeline_runs','question_exposures','question_pool','question_irt',
        'concept_bkt_params','triple_verification_cache',
        'misconception_explanation_cache','learn_content_cache'
    ];
BEGIN
    FOR r IN
        SELECT tablename, policyname
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = ANY(scope)
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, r.tablename);
    END LOOP;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Tier 1 — user-owned tables. Owner-only (read + write).
--    auth.uid() = user_id. Service-role bypasses this, so server paths are
--    unaffected; this blocks anon-key callers from touching others' rows.
-- ────────────────────────────────────────────────────────────────────────────

-- profiles.user_id is TEXT (legacy) — cast auth.uid() to text.
CREATE POLICY "owner_all" ON public.profiles
    FOR ALL
    USING (auth.uid()::text = user_id)
    WITH CHECK (auth.uid()::text = user_id);

-- The rest use uuid user_id.
CREATE POLICY "owner_all" ON public.concepts
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "owner_all" ON public.mastery
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "owner_all" ON public.sessions
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "owner_all" ON public.attempts
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "owner_all" ON public.misconceptions
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "owner_all" ON public.pipeline_runs
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "owner_all" ON public.question_exposures
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Tier 2 + 3 — shared reference data and caches (no per-user ownership).
--    These hold no user PII (question banks, item difficulty, BKT params, and
--    LLM-output caches shared across students). Policy: anyone may SELECT, but
--    NO insert/update/delete policy exists, so only the service-role key can
--    write. This removes client write access (no cache poisoning / pool
--    tampering) while guaranteeing no read path breaks.
-- ────────────────────────────────────────────────────────────────────────────
CREATE POLICY "read_all" ON public.question_pool                   FOR SELECT USING (true);
CREATE POLICY "read_all" ON public.question_irt                    FOR SELECT USING (true);
CREATE POLICY "read_all" ON public.concept_bkt_params              FOR SELECT USING (true);
CREATE POLICY "read_all" ON public.triple_verification_cache       FOR SELECT USING (true);
CREATE POLICY "read_all" ON public.misconception_explanation_cache FOR SELECT USING (true);
CREATE POLICY "read_all" ON public.learn_content_cache             FOR SELECT USING (true);

COMMIT;

-- Refresh PostgREST schema cache.
NOTIFY pgrst, 'reload schema';


-- ============================================================================
-- ROLLBACK (only if a client read pinches and you need to revert fast).
-- Uncomment the whole block and run it. Restores the previous open_all state.
-- No data is touched.
-- ============================================================================
-- BEGIN;
-- DO $$
-- DECLARE
--     r RECORD;
--     t text;
--     scope text[] := ARRAY[
--         'profiles','concepts','mastery','sessions','attempts','misconceptions',
--         'pipeline_runs','question_exposures','question_pool','question_irt',
--         'concept_bkt_params','triple_verification_cache',
--         'misconception_explanation_cache','learn_content_cache'
--     ];
-- BEGIN
--     FOR r IN
--         SELECT tablename, policyname FROM pg_policies
--         WHERE schemaname = 'public' AND tablename = ANY(scope)
--     LOOP
--         EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, r.tablename);
--     END LOOP;
--     FOREACH t IN ARRAY scope LOOP
--         EXECUTE format(
--             'CREATE POLICY "open_all" ON public.%I FOR ALL USING (true) WITH CHECK (true)',
--             t
--         );
--     END LOOP;
-- END $$;
-- COMMIT;
-- NOTIFY pgrst, 'reload schema';