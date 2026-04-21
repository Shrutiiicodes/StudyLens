import { createHash } from 'crypto';
import { getServiceSupabase } from './supabase';

/**
 * Misconception Explanation Cache
 * ────────────────────────────────
 * Skips the LLM call when we've already written an explanation for the same
 * semantic misconception signature.
 *
 * Signature:
 *   sha256(label | correct_answer | student_answer | concept | kg_path)
 *
 * Shared across users — same gap always produces the same explanation.
 * All reads/writes swallow errors and treat the cache as missing, so the
 * analyzer never breaks just because Supabase blips.
 */

export interface CachedExplanation {
    gap_description: string;
    correct_explanation: string;
    source: 'llm' | 'template';
}

export interface ExplanationKey {
    label: string;
    correctAnswer: string;
    studentAnswer: string;
    concept: string;
    kgPath: string[];
}

// ─── Hashing ──────────────────────────────────────────────────────────────

function normalise(s: string): string {
    return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function computeExplanationHash(key: ExplanationKey): string {
    const parts = [
        normalise(key.label),
        normalise(key.correctAnswer),
        normalise(key.studentAnswer),
        normalise(key.concept),
        key.kgPath.map((p) => p.trim()).join(' >> '),
    ].join('||');
    return createHash('sha256').update(parts).digest('hex');
}

// ─── Read ─────────────────────────────────────────────────────────────────

export async function lookupExplanation(
    key: ExplanationKey
): Promise<CachedExplanation | null> {
    try {
        const supabase = getServiceSupabase();
        const hash = computeExplanationHash(key);

        const { data, error } = await supabase
            .from('misconception_explanation_cache')
            .select('gap_description, correct_explanation, source')
            .eq('explanation_hash', hash)
            .maybeSingle();

        if (error || !data) return null;

        // Fire-and-forget hit counter bump.
        void supabase
            .from('misconception_explanation_cache')
            .update({
                last_hit_at: new Date().toISOString(),
                hit_count: (data as any).hit_count
                    ? (data as any).hit_count + 1
                    : undefined,
            })
            .eq('explanation_hash', hash)
            .then(({ error: bumpErr }) => {
                if (bumpErr) {
                    console.warn('[MCCache] Hit bump failed:', bumpErr.message);
                }
            });

        return {
            gap_description: data.gap_description as string,
            correct_explanation: data.correct_explanation as string,
            source: data.source as 'llm' | 'template',
        };
    } catch (err) {
        console.warn('[MCCache] Lookup threw (treating as miss):', (err as Error).message);
        return null;
    }
}

// ─── Write ────────────────────────────────────────────────────────────────

export async function storeExplanation(
    key: ExplanationKey,
    explanation: { gap_description: string; correct_explanation: string },
    source: 'llm' | 'template',
    model?: string
): Promise<void> {
    try {
        const supabase = getServiceSupabase();
        const hash = computeExplanationHash(key);

        const { error } = await supabase
            .from('misconception_explanation_cache')
            .upsert(
                {
                    explanation_hash: hash,
                    gap_description: explanation.gap_description,
                    correct_explanation: explanation.correct_explanation,
                    source,
                    model: source === 'llm' ? model ?? null : null,
                    last_hit_at: new Date().toISOString(),
                },
                { onConflict: 'explanation_hash' }
            );

        if (error) {
            console.warn('[MCCache] Store error (non-fatal):', error.message);
        }
    } catch (err) {
        console.warn('[MCCache] Store threw (non-fatal):', (err as Error).message);
    }
}

// ─── Prior-wrongness check (escalation signal) ────────────────────────────

/**
 * Count how many times this user has been wrong on this concept prior to the
 * current attempt. Used by the analyzer to escalate from template → LLM when
 * the student is repeatedly missing the same concept.
 *
 * Returns 0 on any DB failure.
 */
export async function countPriorWrongAttempts(
    userId: string,
    conceptId: string
): Promise<number> {
    if (!userId || !conceptId) return 0;
    try {
        const supabase = getServiceSupabase();
        const { count, error } = await supabase
            .from('attempts')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('concept_id', conceptId)
            .eq('correct', false);
        if (error) return 0;
        return count ?? 0;
    } catch {
        return 0;
    }
}