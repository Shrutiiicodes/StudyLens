-- ============================================================================
-- Question Pool + Exposure Tracking
-- ============================================================================
-- Caches generated questions per concept so repeat sessions don't pay the
-- LLM cost of regenerating them.
--
-- Strategy:
--   * question_pool stores a pool of generated questions, keyed by
--     (concept_id, type, difficulty). One row per question.
--   * question_exposures logs which student has seen which pool question,
--     so sampling can prefer questions the student hasn't seen recently.
--
-- The mastery-mode weak-spot reinforcement question is NOT cached — it is
-- user-specific by design. Spaced-review questions for OTHER concepts DO
-- sample from those concepts' pools.
--
-- Idempotent. Safe to run on a fresh DB or on top of existing schema.sql.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.question_pool (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    concept_id            uuid NOT NULL REFERENCES public.concepts(id) ON DELETE CASCADE,
    type                  text NOT NULL
                          CHECK (type IN ('recall', 'conceptual', 'application', 'reasoning', 'analytical')),
    difficulty            integer NOT NULL CHECK (difficulty BETWEEN 1 AND 3),
    -- Question payload (shape matches Question interface in src/types/question.ts)
    text                  text NOT NULL,
    options               jsonb NOT NULL,          -- array of 4 strings
    correct_answer        text NOT NULL,
    explanation           text NOT NULL DEFAULT '',
    cognitive_level       integer NOT NULL DEFAULT 1,
    bloom_level           text,
    distractor_distances  jsonb,                   -- { optionText: hopDistance } or null
    -- Audit
    source_context_hash   text,                    -- sha256 of the context at generation time
    created_at            timestamptz NOT NULL DEFAULT now(),
    last_served_at        timestamptz
);

CREATE INDEX IF NOT EXISTS idx_qpool_lookup
    ON public.question_pool(concept_id, type, difficulty);

CREATE INDEX IF NOT EXISTS idx_qpool_created
    ON public.question_pool(created_at DESC);


CREATE TABLE IF NOT EXISTS public.question_exposures (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL,
    pool_question_id uuid NOT NULL REFERENCES public.question_pool(id) ON DELETE CASCADE,
    concept_id    uuid NOT NULL REFERENCES public.concepts(id) ON DELETE CASCADE,
    shown_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qexposure_user_concept
    ON public.question_exposures(user_id, concept_id, shown_at DESC);

CREATE INDEX IF NOT EXISTS idx_qexposure_pool_q
    ON public.question_exposures(pool_question_id);


-- ── RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE public.question_pool      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.question_exposures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "open_all" ON public.question_pool;
DROP POLICY IF EXISTS "open_all" ON public.question_exposures;

-- Open policies match the rest of your dev setup; tighten before production.
CREATE POLICY "open_all" ON public.question_pool      FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "open_all" ON public.question_exposures FOR ALL USING (true) WITH CHECK (true);

-- For production, replace the exposure policy with:
--   CREATE POLICY "users_own_exposures" ON public.question_exposures
--       FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
-- The pool table stays public-readable (it's shared across all students for
-- the same concept) but writes should go through service-role only.

NOTIFY pgrst, 'reload schema';