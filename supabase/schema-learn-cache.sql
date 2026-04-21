-- ============================================================================
-- Learn Mode Content Cache
-- ============================================================================
-- Stores LLM-generated learn-mode content keyed by (concept_id, grade).
-- Repeat visits to the same concept at the same grade hit the cache and
-- skip the LLM call entirely.
--
-- What's cached: the full learn-mode response body (title + sections[]).
-- What's NOT cached: pastMisconceptions (per-user, live — fetched every request).
-- What's NOT cached: KG-path responses (already free — they don't call the LLM).
--
-- TTL: rows older than `ttl_days` (default 30) are considered stale and
-- re-generated on next request. The stale row is overwritten by the upsert,
-- so stale + miss == one LLM call, not two.
--
-- Cascade: cache rows are deleted when the parent concept is deleted.
--
-- Idempotent. Safe to run on a fresh DB or on top of existing schema.sql.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.learn_content_cache (
    concept_id   uuid        NOT NULL,
    grade        text        NOT NULL,
    content      jsonb       NOT NULL,
    -- 'llm' today; reserved for possible future sources (e.g. 'kg-hybrid').
    source       text        NOT NULL DEFAULT 'llm'
                             CHECK (source IN ('llm', 'kg-hybrid')),
    model        text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_hit_at  timestamptz NOT NULL DEFAULT now(),
    hit_count    integer     NOT NULL DEFAULT 1,

    PRIMARY KEY (concept_id, grade),
    FOREIGN KEY (concept_id)
        REFERENCES public.concepts(id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_learn_cache_last_hit
    ON public.learn_content_cache(last_hit_at DESC);

-- RLS — follows the dev-state pattern of the rest of the schema.
-- In production, tighten to require service-role for writes.
ALTER TABLE public.learn_content_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "open_all_learn_cache" ON public.learn_content_cache;
CREATE POLICY "open_all_learn_cache"
    ON public.learn_content_cache
    FOR ALL USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';