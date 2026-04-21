-- ============================================================================
-- Misconception Explanation Cache
-- ============================================================================
-- Stores LLM-generated gap_description / correct_explanation pairs keyed
-- by the semantic signature of the misconception, so repeat occurrences
-- of the same wrong answer skip the LLM call entirely.
--
-- Key (explanation_hash) = sha256 of:
--   label | correct_answer | student_answer | concept | kg_path_joined
--
-- Includes `question_text` is DELIBERATELY EXCLUDED — two slightly-different
-- phrasings of the same conceptual gap should share a cached explanation.
-- The explanation is about the gap, not the wording.
--
-- Idempotent. Safe to run on a fresh DB or on top of existing schema.sql.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.misconception_explanation_cache (
    explanation_hash      text PRIMARY KEY,      -- sha256 of signature
    gap_description       text NOT NULL,
    correct_explanation   text NOT NULL,
    source                text NOT NULL          -- 'llm' | 'template'
                          CHECK (source IN ('llm', 'template')),
    model                 text,                  -- when source='llm'
    created_at            timestamptz NOT NULL DEFAULT now(),
    last_hit_at           timestamptz NOT NULL DEFAULT now(),
    hit_count             integer NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_mc_explain_last_hit
    ON public.misconception_explanation_cache(last_hit_at DESC);

-- Shared across users (same gap → same explanation regardless of student).
ALTER TABLE public.misconception_explanation_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "open_read_mc_cache"  ON public.misconception_explanation_cache;
DROP POLICY IF EXISTS "open_all_mc_cache"   ON public.misconception_explanation_cache;

-- Open policy matches the dev-state of the rest of the schema.
-- For production, keep SELECT open but require service-role for writes.
CREATE POLICY "open_all_mc_cache"
    ON public.misconception_explanation_cache
    FOR ALL USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';