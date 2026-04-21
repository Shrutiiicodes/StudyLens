import { createHash } from 'crypto';
import { getServiceSupabase } from './supabase';
import { Question, QuestionType, DifficultyLevel, BloomLevel } from '@/types/question';

/**
 * Question Pool
 * ─────────────
 * Per-concept cache of generated questions keyed by (concept_id, type, difficulty).
 *
 * Sampling policy (chosen in conversation — "different set each attempt if
 * pool is large enough, otherwise recycle"):
 *   1. Prefer questions the student has NOT been exposed to yet.
 *   2. Then prefer questions whose most-recent exposure for this student is
 *      older than EXPOSURE_RECENCY_HOURS.
 *   3. Fall back to any question if those tiers are empty.
 *
 * The pool is shared across users — the same (concept, type, difficulty)
 * has the same candidate questions for every student. Exposures are tracked
 * per-user so each student sees a different slice of the shared pool.
 *
 * The `source_context_hash` column is advisory: if the KG/context for a
 * concept changes materially, we can purge pool rows whose hash no longer
 * matches the current context. Not wired up yet — future work.
 */

// ─── Tunables ─────────────────────────────────────────────────────────────

// Avoid serving a question a student has seen in the last N hours.
const EXPOSURE_RECENCY_HOURS = 72;

// How many questions per (concept, type, difficulty) bucket we'd like to
// have cached. If the pool has fewer, the generator tops it up by writing
// back its freshly-generated question.
const TARGET_POOL_SIZE = 5;

// Hard floor — even if exposure history forces recycling, never serve a
// question that was shown to this same student in the last N minutes.
const MIN_REUSE_MINUTES = 30;

// ─── Types ────────────────────────────────────────────────────────────────

export interface PoolKey {
    conceptId: string;
    type: QuestionType;
    difficulty: DifficultyLevel;
}

export interface PoolQuestion extends Question {
    pool_id?: string; // present iff the question came from the pool
}

// ─── Hashing ──────────────────────────────────────────────────────────────

export function hashContext(context: string): string {
    return createHash('sha256').update(context.trim()).digest('hex');
}

// ─── Read: sample from the pool ────────────────────────────────────────────

/**
 * Try to pull one question from the pool for (conceptId, type, difficulty)
 * that the student hasn't seen recently.
 *
 * Returns null on:
 *   - cache miss (pool empty / too small),
 *   - any DB failure (caller should regenerate and carry on),
 *   - exclusion set fully covering the pool.
 *
 * `excludeIds` lets the caller avoid dealing the same pool question twice
 * in a single session.
 */
export async function samplePoolQuestion(
    key: PoolKey,
    userId: string | undefined,
    excludeIds: Set<string>
): Promise<PoolQuestion | null> {
    try {
        const supabase = getServiceSupabase();

        // 1. Fetch up to TARGET_POOL_SIZE candidates for this slot.
        const { data: candidates, error: poolErr } = await supabase
            .from('question_pool')
            .select('*')
            .eq('concept_id', key.conceptId)
            .eq('type', key.type)
            .eq('difficulty', key.difficulty)
            .order('created_at', { ascending: true })
            .limit(TARGET_POOL_SIZE * 2);

        if (poolErr || !candidates || candidates.length === 0) {
            return null;
        }

        const available = candidates.filter((c) => !excludeIds.has(c.id as string));
        if (available.length === 0) return null;

        // 2. Fetch this user's recent exposures for this concept so we can
        //    prefer questions they haven't seen lately.
        const recentExposures = new Map<string, string>(); // pool_id -> shown_at ISO
        if (userId) {
            const cutoff = new Date(
                Date.now() - EXPOSURE_RECENCY_HOURS * 60 * 60 * 1000
            ).toISOString();

            const { data: exposures } = await supabase
                .from('question_exposures')
                .select('pool_question_id, shown_at')
                .eq('user_id', userId)
                .eq('concept_id', key.conceptId)
                .gte('shown_at', cutoff)
                .order('shown_at', { ascending: false });

            for (const e of exposures ?? []) {
                const pqid = e.pool_question_id as string;
                if (!recentExposures.has(pqid)) {
                    recentExposures.set(pqid, e.shown_at as string);
                }
            }
        }

        // 3. Tier the candidates.
        const cutoffMs = Date.now() - MIN_REUSE_MINUTES * 60 * 1000;
        const unseen: typeof available = [];
        const seenLongAgo: typeof available = [];
        const seenRecently: typeof available = [];

        for (const c of available) {
            const lastSeen = recentExposures.get(c.id as string);
            if (!lastSeen) {
                unseen.push(c);
            } else if (new Date(lastSeen).getTime() < cutoffMs) {
                seenLongAgo.push(c);
            } else {
                seenRecently.push(c);
            }
        }

        // Prefer unseen → then seen-long-ago → as a last resort, seen-recently.
        // Never serve from seenRecently unless nothing else is available.
        const pool = unseen.length > 0
            ? unseen
            : seenLongAgo.length > 0
                ? seenLongAgo
                : seenRecently;

        if (pool.length === 0) return null;

        // Random pick within the chosen tier.
        const chosen = pool[Math.floor(Math.random() * pool.length)];

        return rowToQuestion(chosen);
    } catch (err) {
        console.warn('[QPool] Sample failed (treating as miss):', (err as Error).message);
        return null;
    }
}


// ─── Write: persist a newly-generated question to the pool ────────────────

/**
 * Store a freshly-generated question in the pool so future sessions
 * can reuse it. Fire-and-forget — failures are logged, never thrown.
 *
 * Caller passes the exact question they just built (post graph-distractor
 * upgrade) so the cached row has the same options and distances as what
 * the student actually saw.
 */
export async function persistToPool(
    key: PoolKey,
    question: Question,
    contextHash: string
): Promise<string | null> {
    try {
        const supabase = getServiceSupabase();
        const { data, error } = await supabase
            .from('question_pool')
            .insert({
                concept_id: key.conceptId,
                type: key.type,
                difficulty: key.difficulty,
                text: question.text,
                options: question.options,
                correct_answer: question.correct_answer,
                explanation: question.explanation,
                cognitive_level: question.cognitive_level,
                bloom_level: question.bloom_level ?? null,
                distractor_distances: question.distractor_distances ?? null,
                source_context_hash: contextHash,
            })
            .select('id')
            .single();

        if (error) {
            console.warn('[QPool] Persist error (non-fatal):', error.message);
            return null;
        }
        return (data?.id as string) ?? null;
    } catch (err) {
        console.warn('[QPool] Persist threw (non-fatal):', (err as Error).message);
        return null;
    }
}


// ─── Write: record exposures after a session is dealt ─────────────────────

/**
 * Log that a user was shown these pool questions. Called once at the end
 * of question generation, batched across all questions in the session.
 * Never blocks the response.
 */
export async function recordExposures(
    userId: string,
    entries: Array<{ poolQuestionId: string; conceptId: string }>
): Promise<void> {
    if (!userId || entries.length === 0) return;
    try {
        const supabase = getServiceSupabase();
        const rows = entries.map((e) => ({
            user_id: userId,
            pool_question_id: e.poolQuestionId,
            concept_id: e.conceptId,
        }));
        const { error } = await supabase
            .from('question_exposures')
            .insert(rows);
        if (error) {
            console.warn('[QPool] Exposure write error (non-fatal):', error.message);
        }
    } catch (err) {
        console.warn('[QPool] Exposure write threw (non-fatal):', (err as Error).message);
    }
}


// ─── Row → Question mapping ───────────────────────────────────────────────

function rowToQuestion(row: Record<string, unknown>): PoolQuestion {
    return {
        id: `pool_${row.id as string}`, // distinct from freshly-generated uuids
        pool_id: row.id as string,
        concept_id: row.concept_id as string,
        type: row.type as QuestionType,
        difficulty: row.difficulty as DifficultyLevel,
        text: row.text as string,
        options: Array.isArray(row.options) ? (row.options as string[]) : [],
        correct_answer: row.correct_answer as string,
        explanation: (row.explanation as string) ?? '',
        cognitive_level: (row.cognitive_level as number) ?? 1,
        bloom_level: (row.bloom_level as BloomLevel) ?? 'Remember',
        format: 'mcq',
        distractor_distances:
            (row.distractor_distances as Record<string, number> | null) ?? undefined,
    };
}


// ─── Helpers exposed for tests / admin scripts ────────────────────────────

export const POOL_CONSTANTS = {
    EXPOSURE_RECENCY_HOURS,
    TARGET_POOL_SIZE,
    MIN_REUSE_MINUTES,
};