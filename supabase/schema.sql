-- ============================================================================
-- Study-Lens canonical schema
-- ============================================================================
-- Single source of truth for the public schema. Idempotent — safe to run on
-- a fresh database or on an existing one. Run this instead of the (missing)
-- migrations 001-003 referenced in the old README.
--
-- Run order of concerns:
--   1. Tables (with FKs)
--   2. Indexes
--   3. RLS enablement + policies
--
-- Notes for deploy:
--   - This assumes Supabase auth (auth.users exists).
--   - profiles.user_id is text (legacy); concepts/sessions/etc. use uuid.
--     Don't "fix" this without a data migration — anon users without
--     auth.users rows exist in the wild.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1. Tables
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.profiles (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       text NOT NULL,
    full_name     text,
    email         text,
    grade         integer DEFAULT 6,
    created_at    timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.concepts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL,
    title           text NOT NULL,
    source_document text,
    created_at      timestamptz DEFAULT timezone('utc', now())
);

CREATE TABLE IF NOT EXISTS public.mastery (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL,
    concept_id      uuid REFERENCES public.concepts(id) ON DELETE CASCADE,
    mastery_score   double precision DEFAULT 0,
    current_stage   text DEFAULT 'diagnostic',
    last_updated    timestamptz DEFAULT timezone('utc', now()),
    fsrs_stability  double precision DEFAULT 1.0,
    fsrs_difficulty double precision DEFAULT 5.0,
    UNIQUE (user_id, concept_id)
);

CREATE TABLE IF NOT EXISTS public.sessions (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           uuid NOT NULL REFERENCES auth.users(id),
    concept_id        uuid NOT NULL REFERENCES public.concepts(id) ON DELETE CASCADE,
    mode              text NOT NULL,
    score             integer NOT NULL,
    passed            boolean NOT NULL,
    -- Legacy custom metrics
    fas               double precision,
    wbs               double precision,
    ccms              double precision,
    mss               double precision,
    lip               double precision,
    rci_avg           double precision,
    calibration_error double precision,
    convergence_rate  integer,
    -- Standard ITS metrics
    nlg               double precision,
    brier_score       double precision,
    ece               double precision,
    log_loss          double precision,
    created_at        timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.misconceptions (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              uuid NOT NULL,
    concept_id           uuid REFERENCES public.concepts(id),
    session_id           uuid REFERENCES public.sessions(id),
    question_text        text,
    student_answer       text,
    correct_answer       text,
    is_correct           boolean NOT NULL DEFAULT false,
    score                double precision NOT NULL DEFAULT 0,
    severity             text CHECK (severity IN ('CORRECT', 'CLOSE', 'PARTIAL', 'CRITICAL')),
    misconception_label  text,
    gap_description      text,
    correct_explanation  text,
    hint                 text,
    kg_path              jsonb DEFAULT '[]'::jsonb,
    checks               jsonb DEFAULT '{}'::jsonb,
    distractor_distance  integer,
    created_at           timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.attempts (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           uuid NOT NULL,
    concept_id        uuid REFERENCES public.concepts(id) ON DELETE CASCADE,
    session_id        uuid REFERENCES public.sessions(id),
    misconception_id  uuid REFERENCES public.misconceptions(id),
    question_id       text NOT NULL,
    question_text     text,
    question_type     text DEFAULT 'recall',
    correct           boolean NOT NULL,
    correct_answer    text,
    selected_answer   text,
    explanation       text,
    difficulty        integer NOT NULL,
    cognitive_level   integer NOT NULL,
    time_taken        integer NOT NULL,
    confidence        double precision DEFAULT 0.5,
    difficulty_param  double precision DEFAULT 0.0,
    student_theta     double precision DEFAULT 0.0,
    severity          text,
    source_chunk      text,
    mode              text DEFAULT 'diagnostic',
    is_spaced_review  boolean DEFAULT false,
    created_at        timestamptz DEFAULT timezone('utc', now())
);

CREATE TABLE IF NOT EXISTS public.question_irt (
    question_id      text PRIMARY KEY,
    difficulty_param double precision NOT NULL DEFAULT 0.0,
    response_count   integer NOT NULL DEFAULT 0,
    last_updated     timestamptz DEFAULT timezone('utc', now())
);

CREATE TABLE IF NOT EXISTS public.concept_bkt_params (
    concept_id     uuid PRIMARY KEY REFERENCES public.concepts(id) ON DELETE CASCADE,
    p_l0           double precision NOT NULL DEFAULT 0.25,
    p_t            double precision NOT NULL DEFAULT 0.12,
    p_s            double precision NOT NULL DEFAULT 0.08,
    p_g            double precision NOT NULL DEFAULT 0.25,
    log_likelihood double precision,
    n_sequences    integer DEFAULT 0,
    n_attempts     integer DEFAULT 0,
    fitted_at      timestamptz DEFAULT timezone('utc', now())
);

CREATE TABLE IF NOT EXISTS public.pipeline_runs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL,
    concept_id      uuid REFERENCES public.concepts(id),
    doc_id          text NOT NULL DEFAULT '',
    storage_path    text NOT NULL,
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'running', 'complete', 'failed')),
    page_count      integer,
    chunk_count     integer,
    triple_count    integer,
    question_count  integer,
    quality_score   double precision,
    ocr_applied     boolean DEFAULT false,
    error_message   text,
    started_at      timestamptz DEFAULT now(),
    completed_at    timestamptz
);


-- ────────────────────────────────────────────────────────────────────────────
-- 2. Indexes
-- ────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_concepts_user_id            ON public.concepts(user_id);

CREATE INDEX IF NOT EXISTS idx_mastery_user_id             ON public.mastery(user_id);
CREATE INDEX IF NOT EXISTS idx_mastery_concept_id          ON public.mastery(concept_id);

CREATE INDEX IF NOT EXISTS idx_sessions_user               ON public.sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_concept            ON public.sessions(concept_id);
CREATE INDEX IF NOT EXISTS idx_sessions_concept_user       ON public.sessions(user_id, concept_id);
CREATE INDEX IF NOT EXISTS idx_sessions_nlg                ON public.sessions(nlg);
CREATE INDEX IF NOT EXISTS idx_sessions_brier              ON public.sessions(brier_score);

CREATE INDEX IF NOT EXISTS idx_attempts_user_id            ON public.attempts(user_id);
CREATE INDEX IF NOT EXISTS idx_attempts_concept_id         ON public.attempts(concept_id);
CREATE INDEX IF NOT EXISTS idx_attempts_created_at         ON public.attempts(created_at);
CREATE INDEX IF NOT EXISTS idx_attempts_difficulty_param   ON public.attempts(difficulty_param);
CREATE INDEX IF NOT EXISTS idx_attempts_question_type      ON public.attempts(question_type);
CREATE INDEX IF NOT EXISTS idx_attempts_spaced_review      ON public.attempts(is_spaced_review)
    WHERE is_spaced_review = true;

CREATE INDEX IF NOT EXISTS idx_misconceptions_session         ON public.misconceptions(session_id);
CREATE INDEX IF NOT EXISTS idx_misconceptions_user_concept    ON public.misconceptions(user_id, concept_id);
CREATE INDEX IF NOT EXISTS idx_misconceptions_severity        ON public.misconceptions(severity)
    WHERE severity IN ('PARTIAL', 'CRITICAL');

CREATE INDEX IF NOT EXISTS idx_question_irt_param          ON public.question_irt(difficulty_param);

CREATE INDEX IF NOT EXISTS idx_concept_bkt_fitted_at       ON public.concept_bkt_params(fitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_user          ON public.pipeline_runs(user_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_concept       ON public.pipeline_runs(concept_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_doc           ON public.pipeline_runs(doc_id);


-- ────────────────────────────────────────────────────────────────────────────
-- 3. Row-Level Security
-- ────────────────────────────────────────────────────────────────────────────
-- Enable RLS on every table. Current policies are OPEN (ALL USING (true)) —
-- this matches your dev state. For a real deployment, replace them with
-- auth.uid()-based policies. See the TODO block at the bottom of this file.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.profiles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.concepts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mastery            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attempts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.misconceptions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.question_irt       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.concept_bkt_params ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipeline_runs      ENABLE ROW LEVEL SECURITY;

-- Drop any existing open policies so re-running this script is clean.
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN
        SELECT tablename, policyname
        FROM pg_policies
        WHERE schemaname = 'public'
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, r.tablename);
    END LOOP;
END $$;

-- OPEN policies — match current dev state. REPLACE BEFORE PUBLIC DEPLOYMENT.
CREATE POLICY "open_all" ON public.profiles           FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "open_all" ON public.concepts           FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "open_all" ON public.mastery            FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "open_all" ON public.sessions           FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "open_all" ON public.attempts           FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "open_all" ON public.misconceptions     FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "open_all" ON public.question_irt       FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "open_all" ON public.concept_bkt_params FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "open_all" ON public.pipeline_runs      FOR ALL USING (true) WITH CHECK (true);


-- ────────────────────────────────────────────────────────────────────────────
-- TODO: Before a real public deployment, replace the open policies above with
-- ownership-based ones. Example for concepts:
--
--   DROP POLICY IF EXISTS "open_all" ON public.concepts;
--   CREATE POLICY "users_own_concepts" ON public.concepts
--       FOR ALL
--       USING (user_id = auth.uid())
--       WITH CHECK (user_id = auth.uid());
--
-- Repeat for mastery, sessions, attempts, misconceptions, pipeline_runs.
-- profiles: match on `user_id = auth.uid()::text` since profiles.user_id
-- is text, not uuid.
-- concept_bkt_params and question_irt are shared across users — these can
-- stay open to SELECT but should require service-role for INSERT/UPDATE.
--
-- See Supabase docs: https://supabase.com/docs/guides/database/postgres/row-level-security
-- ────────────────────────────────────────────────────────────────────────────


-- ────────────────────────────────────────────────────────────────────────────
-- 4. Refresh PostgREST schema cache
-- ────────────────────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';