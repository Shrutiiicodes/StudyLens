import { createHash } from 'crypto';
import { getServiceSupabase } from './supabase';

/**
 * Triple-Verification Cache
 * ─────────────────────────
 * Skips the LLM verification call when we've already judged the same
 * (subject, predicate, object) triple against the same source passage.
 *
 * Keying
 *   triple_hash = sha256(normalized_subject | predicate | normalized_object | chunk_hash)
 *   chunk_hash  = sha256(source_chunk_text)
 *
 * Subject and object are lower-cased and trimmed before hashing so minor
 * whitespace / casing differences collapse to the same key. Predicate is
 * upper-cased (it's always in the fixed ontology).
 *
 * The cache is shared across users — the same triple extracted from the
 * same passage always gets the same verdict regardless of which student
 * uploaded the PDF. This is what makes re-uploads free.
 */

export interface CachedVerdict {
    kept: boolean;
    verdict: 'a' | 'b' | 'c';
    confidence: number;
}

export interface TripleKey {
    subject: string;
    predicate: string;
    object: string;
    chunkText: string;
}

// ─── Hashing ──────────────────────────────────────────────────────────────

function sha256(input: string): string {
    return createHash('sha256').update(input).digest('hex');
}

export function computeChunkHash(chunkText: string): string {
    // Hash the whole chunk. Stable across re-uploads of the same document.
    return sha256(chunkText.trim());
}

export function computeTripleHash(key: TripleKey): string {
    const s = key.subject.trim().toLowerCase();
    const p = key.predicate.trim().toUpperCase();
    const o = key.object.trim().toLowerCase();
    const chunkHash = computeChunkHash(key.chunkText);
    return sha256(`${s}||${p}||${o}||${chunkHash}`);
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Batch-lookup verdicts for a list of triples.
 * Returns a Map keyed by triple_hash → CachedVerdict for hits only.
 * Misses simply won't appear in the Map; the caller should LLM-verify those.
 *
 * Failures are swallowed and treated as a cache miss — the pipeline never
 * breaks just because the cache is unavailable.
 */
export async function lookupVerdicts(
    triples: TripleKey[]
): Promise<Map<string, CachedVerdict>> {
    const out = new Map<string, CachedVerdict>();
    if (triples.length === 0) return out;

    const hashes = triples.map(computeTripleHash);

    try {
        const supabase = getServiceSupabase();
        const { data, error } = await supabase
            .from('triple_verification_cache')
            .select('triple_hash, verdict, confidence, kept')
            .in('triple_hash', hashes);

        if (error) {
            console.warn('[TripleCache] Lookup error (treating as miss):', error.message);
            return out;
        }

        for (const row of data ?? []) {
            out.set(row.triple_hash as string, {
                kept: row.kept as boolean,
                verdict: row.verdict as 'a' | 'b' | 'c',
                confidence: row.confidence as number,
            });
        }

        // Fire-and-forget: bump last_hit_at on hits so we can expire cold
        // entries later if the table ever gets large.
        if (out.size > 0) {
            const hitHashes = Array.from(out.keys());
            void supabase
                .from('triple_verification_cache')
                .update({ last_hit_at: new Date().toISOString() })
                .in('triple_hash', hitHashes)
                .then(({ error: updateError }) => {
                    if (updateError) {
                        console.warn('[TripleCache] last_hit_at bump failed:', updateError.message);
                    }
                });
        }
    } catch (err) {
        console.warn('[TripleCache] Lookup threw (treating as miss):', (err as Error).message);
    }

    return out;
}

/**
 * Persist a verdict. Upserts on triple_hash — re-verifying the same triple
 * overwrites the prior decision (useful when the verifier model improves).
 */
export async function storeVerdict(
    triple: TripleKey,
    verdict: CachedVerdict,
    model: string
): Promise<void> {
    try {
        const supabase = getServiceSupabase();
        const hash = computeTripleHash(triple);
        const { error } = await supabase
            .from('triple_verification_cache')
            .upsert(
                {
                    triple_hash: hash,
                    verdict: verdict.verdict,
                    confidence: verdict.confidence,
                    kept: verdict.kept,
                    model,
                    last_hit_at: new Date().toISOString(),
                },
                { onConflict: 'triple_hash' }
            );
        if (error) {
            console.warn('[TripleCache] Store error (non-fatal):', error.message);
        }
    } catch (err) {
        console.warn('[TripleCache] Store threw (non-fatal):', (err as Error).message);
    }
}

/**
 * Batch-store many verdicts in one round-trip.
 */
export async function storeVerdictsBatch(
    entries: Array<{ triple: TripleKey; verdict: CachedVerdict }>,
    model: string
): Promise<void> {
    if (entries.length === 0) return;
    try {
        const supabase = getServiceSupabase();
        const rows = entries.map(({ triple, verdict }) => ({
            triple_hash: computeTripleHash(triple),
            verdict: verdict.verdict,
            confidence: verdict.confidence,
            kept: verdict.kept,
            model,
            last_hit_at: new Date().toISOString(),
        }));
        const { error } = await supabase
            .from('triple_verification_cache')
            .upsert(rows, { onConflict: 'triple_hash' });
        if (error) {
            console.warn('[TripleCache] Batch store error (non-fatal):', error.message);
        }
    } catch (err) {
        console.warn('[TripleCache] Batch store threw (non-fatal):', (err as Error).message);
    }
}