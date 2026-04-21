-- ============================================================================
-- Triple-verification cache
-- ============================================================================
-- Stores the LLM's verdict on each (subject, predicate, object, chunk) tuple
-- so that re-uploads of the same document — or documents that share passages
-- with earlier uploads — skip the verification LLM call entirely.
--
-- Key design:
--   triple_hash = sha256(lower(subject) + '|' + upper(predicate) + '|' + lower(object) + '|' + chunk_hash)
--   chunk_hash  = sha256 of the source-passage text (first 500 chars is fine)
-- Both hashes are computed in the app layer — the DB just stores them.
--
-- Idempotent. Safe to run on a fresh DB or on top of existing schema.sql.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.triple_verification_cache (
    triple_hash  text PRIMARY KEY,        -- sha256 of s||p||o||chunk_hash
    verdict      text NOT NULL            -- 'a' | 'b' | 'c'
                 CHECK (verdict IN ('a', 'b', 'c')),
    confidence   double precision NOT NULL DEFAULT 0.0,
    kept         boolean NOT NULL,        -- resolved decision: passed filter or not
    model        text,                    -- which LLM produced this verdict
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_hit_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_triple_cache_last_hit
    ON public.triple_verification_cache(last_hit_at DESC);

-- RLS: cache is shared across users (same triple from same passage always
-- gets the same verdict). Service-role writes only; open read is fine.
ALTER TABLE public.triple_verification_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "open_read_cache"  ON public.triple_verification_cache;
DROP POLICY IF EXISTS "service_write_cache" ON public.triple_verification_cache;

CREATE POLICY "open_read_cache"
    ON public.triple_verification_cache
    FOR SELECT
    USING (true);

-- Writes gated to service role via app — no INSERT/UPDATE policy for
-- authenticated users means only service-role key can write.

NOTIFY pgrst, 'reload schema';