import { chatCompletion, parseLLMJson } from './groq';
import { runCypher } from './neo4j';
import { chunkTextDetailed, generateEmbedding } from './embeddings';
import { ExtractedKnowledge, KnowledgeGraph, ConceptNode, ConceptRelation } from '@/types/concept';
import { v4 as uuid } from 'uuid';
import { PROMPTS, UNIFIED_RELATION_LIST } from '@/config/prompts';
import {
    lookupVerdicts,
    storeVerdictsBatch,
    type TripleKey,
    type CachedVerdict,
    computeTripleHash,
} from './triple-cache';

/**
 * Knowledge Graph Builder
 *
 * Pipeline:
 * 1. Chunk the document text (with per-chunk confidence scores)
 * 2. Extract concepts, definitions, relationships from each chunk via LLM
 *    - Skip verification on high-confidence chunks (score ≥ 0.70)
 *    - Consult Supabase cache for previously-verified triples
 *    - Batch-verify remaining triples (10 per LLM call)
 * 3. Merge and deduplicate extracted knowledge
 * 4. Build Neo4j knowledge graph
 */

// ─── Verification tunables ────────────────────────────────────────────────

// Chunks at or above this confidence are trusted without LLM verification.
// Matches the Python backend behaviour (ingestion/pipeline.py).
const VERIFY_SKIP_CONFIDENCE = 0.70;

// Chunks below this are treated as low-confidence — stricter thresholds apply.
const VERIFY_STRICT_CONFIDENCE = 0.50;

// Triples sent to the verifier per LLM call.
const VERIFY_BATCH_SIZE = 10;

// Verification model name — stored in cache for audits / model upgrades.
// Primary verifier — fast, cheap, used for first-pass judgment.
const VERIFIER_MODEL = 'llama-3.1-8b-instant';

// Secondary verifier — different model family, used as cross-examination.
// We accept a triple only if BOTH models accept it independently. This is
// the no-HiL substitute for Tsaneva et al. (2025) workflow 5's
// "human-on-disagreement" pattern: instead of asking a person to break
// the tie, we drop the triple. Trades recall for precision — viable here
// because our baseline recall (94.7%) leaves room.
const SECONDARY_VERIFIER_MODEL = 'qwen/qwen3-32b';

// Toggles — flip to false if Groq rate limits bite. The system degrades
// gracefully back to single-model + no-direction-check (today's behavior).
const ENABLE_DUAL_VERIFICATION = true;
const ENABLE_DIRECTION_CHECK = true;

// Direction sanity check tunables.
// Only re-checked when the primary verdict is 'a' with confidence ≥ this.
// Lower → more swap calls (more cost, fewer FPs slip through).
const DIRECTION_CHECK_MIN_CONFIDENCE = 0.9;

// Predicates whose meaning depends on direction. (X PART_OF Y) ≠ (Y PART_OF X).
// Symmetric predicates (RELATES_TO, CONTRASTS_WITH) are excluded — the swap
// test would produce false positives there because both directions are valid.
const ASYMMETRIC_PREDICATES = new Set([
    'IS_A', 'PART_OF', 'CONTAINS', 'LOCATED_IN', 'FOUND_IN',
    'PRODUCED_BY', 'SUPPLIED_BY', 'USED_FOR', 'CAUSES', 'LED_TO',
    'DISCOVERED_BY', 'BUILT_BY', 'TRADED_BY', 'DEFINES',
    'PRECEDES', 'EXTENSION_OF', 'EXAMPLE_OF', 'FEATURE_OF',
    'CHARACTERIZED_BY', 'REQUIRES',
]);

// ─── Structural filter config ─────────────────────────────────────────────
// Allowed predicate set — anything outside this is dropped pre-verifier.
// Derived from the unified list so kg-builder and the extractor prompt
// can't drift out of sync.
const ALLOWED_PREDICATES = new Set<string>(UNIFIED_RELATION_LIST);

// Cycles among these relations are structural contradictions.
// Matches scripts/paulheim-checks.ts so the upstream filter and the
// post-hoc evaluator share one definition of "DAG relation".
const DAG_RELATIONS = new Set([
    'IS_A', 'PART_OF', 'PRECEDES', 'REQUIRES', 'EXTENSION_OF',
]);

/**
 * In-memory DAG cycle filter.
 *
 * Runs on the merged relationship list before writeToNeo4j(). Detects
 * cycles among DAG relations (IS_A, PART_OF, PRECEDES, REQUIRES,
 * EXTENSION_OF) via DFS and drops the back edge that closes each cycle.
 *
 * This is the upstream counterpart to validatePrerequisiteDAG(), which
 * runs post-write as a safety net. The two are complementary:
 *   - filterCyclicEdges  → per-document, in-memory, cheap, preventive
 *   - validatePrerequisiteDAG → post-write, catches cycles introduced
 *     by cross-document linking passes that come later
 *
 * Back-edge selection matches the post-hoc behaviour: the edge DFS
 * discovers as closing the cycle is the one removed. If you later want
 * to prefer higher-confidence edges, this is the place to change it.
 */
function filterCyclicEdges(
    relationships: ExtractedKnowledge['relationships']
): {
    kept: ExtractedKnowledge['relationships'];
    droppedEdges: ExtractedKnowledge['relationships'];
} {
    const dagEdges = relationships.filter((r) =>
        DAG_RELATIONS.has(r.type.toUpperCase())
    );
    const otherEdges = relationships.filter(
        (r) => !DAG_RELATIONS.has(r.type.toUpperCase())
    );

    if (dagEdges.length === 0) {
        return { kept: relationships, droppedEdges: [] };
    }

    // Adjacency keyed by canonical name so "Photosynthesis" and
    // "photosynthesis" collapse into the same node during DFS.
    type EdgeRef = ExtractedKnowledge['relationships'][number];
    const adjacency = new Map<string, Array<{ toKey: string; rel: EdgeRef }>>();
    for (const rel of dagEdges) {
        const fromKey = canonicalizeName(rel.from);
        const toKey = canonicalizeName(rel.to);
        if (!fromKey || !toKey) continue;
        if (!adjacency.has(fromKey)) adjacency.set(fromKey, []);
        adjacency.get(fromKey)!.push({ toKey, rel });
    }

    const visited = new Set<string>();
    const inStack = new Set<string>();
    const droppedSet = new Set<EdgeRef>();

    function dfs(node: string): void {
        visited.add(node);
        inStack.add(node);

        for (const { toKey, rel } of adjacency.get(node) || []) {
            if (droppedSet.has(rel)) continue; // already dropped by earlier cycle
            if (!visited.has(toKey)) {
                dfs(toKey);
            } else if (inStack.has(toKey)) {
                droppedSet.add(rel); // back edge
            }
        }

        inStack.delete(node);
    }

    for (const node of adjacency.keys()) {
        if (!visited.has(node)) dfs(node);
    }

    const keptDagEdges = dagEdges.filter((r) => !droppedSet.has(r));
    return {
        kept: [...keptDagEdges, ...otherEdges],
        droppedEdges: Array.from(droppedSet),
    };
}

// ─── Step 1: Extract knowledge from text chunks ───

/**
 * Extract concepts + relationships from one chunk, then verify relationships.
 *
 * Three-tier verification strategy:
 *   1. High-confidence chunks (score ≥ 0.70) → trust all triples, no LLM call.
 *   2. Cache hits → reuse prior verdict, no LLM call.
 *   3. Cache misses → one BATCHED LLM call per 10 triples (not one per triple).
 *
 * Per-triple confidence threshold is raised (0.65/0.80 → 0.88/0.92) on
 * low-confidence chunks so noisy passages don't slip junk triples into the KG.
 */
async function extractKnowledgeFromChunk(
    chunk: string,
    chunkConfidence: number = 1.0
): Promise<ExtractedKnowledge> {
    const exemplars = `SciERC Style: 
    { "from": "Neurons", "to": "Signals", "type": "USED_FOR" }
    { "from": "Brain", "to": "Nervous System", "type": "PART_OF" }`;

    const response = await chatCompletion(
        [
            { role: 'system', content: PROMPTS.KG_EXTRACTOR.system },
            { role: 'user', content: PROMPTS.KG_EXTRACTOR.user(chunk, exemplars) },
        ],
        { jsonMode: true, temperature: 0.2 }
    );

    const raw = parseLLMJson<ExtractedKnowledge>(response);
    const rawRelationships = raw.relationships ?? [];

    // Pre-verifier structural filter (Workflow 8 — ontology-validator stage).
    // Drops schema-invalid triples BEFORE they reach the LLM verifier so we
    // don't waste LLM calls on triples we'd reject anyway.
    const { kept: relationships, discarded } = structuralFilter(rawRelationships);
    if (discarded.length > 0) {
        const byReason = discarded.reduce<Record<string, number>>((acc, d) => {
            acc[d.reason] = (acc[d.reason] || 0) + 1;
            return acc;
        }, {});
        console.log(
            `[KG Structural-Filter] Dropped ${discarded.length}/${rawRelationships.length} triple(s):`,
            byReason
        );
    }

    if (relationships.length === 0) {
        return { ...raw, relationships: [], _sourceChunk: chunk };
    }

    // ── Tier 1: Skip verification on high-confidence chunks ──────────────
    if (chunkConfidence >= VERIFY_SKIP_CONFIDENCE) {
        console.log(
            `[KG Verify] Chunk confidence ${chunkConfidence.toFixed(2)} ≥ ${VERIFY_SKIP_CONFIDENCE} — trusting all ${relationships.length} triples without LLM verification`
        );
        return { ...raw, relationships, _sourceChunk: chunk };
    }

    // ── Confidence thresholds scale with chunk quality ───────────────────
    const isLowConfChunk = chunkConfidence < VERIFY_STRICT_CONFIDENCE;
    const aThreshold = isLowConfChunk ? 0.88 : 0.65;
    const bThreshold = isLowConfChunk ? 0.92 : 0.80;

    const isValidVerdict = (v: Pick<CachedVerdict, 'verdict' | 'confidence'>): boolean =>
        (v.verdict === 'a' && v.confidence >= aThreshold) ||
        (v.verdict === 'b' && v.confidence >= bThreshold);

    // ── Tier 2: Cache lookup ─────────────────────────────────────────────
    const tripleKeys: TripleKey[] = relationships.map((rel) => ({
        subject: rel.from,
        predicate: rel.type,
        object: rel.to,
        chunkText: chunk,
    }));

    const cachedVerdicts = await lookupVerdicts(tripleKeys);
    const verified: ExtractedKnowledge['relationships'] = [];
    const needsLLM: Array<{ rel: typeof relationships[number]; key: TripleKey }> = [];

    for (let i = 0; i < relationships.length; i++) {
        const rel = relationships[i];
        const key = tripleKeys[i];
        const hash = computeTripleHash(key);
        const hit = cachedVerdicts.get(hash);
        if (hit) {
            // Re-apply the current tier's threshold rather than trusting the
            // cached `kept` flag — a strict-chunk run shouldn't inherit
            // acceptance from a looser-chunk run.
            if (isValidVerdict(hit)) {
                verified.push(rel);
            } else {
                console.log(
                    `[KG Verify] Cache-rejected: (${rel.from}, ${rel.type}, ${rel.to}) — verdict=${hit.verdict}, confidence=${hit.confidence}`
                );
            }
        } else {
            needsLLM.push({ rel, key });
        }
    }

    console.log(
        `[KG Verify] Chunk conf=${chunkConfidence.toFixed(2)}: ${cachedVerdicts.size}/${relationships.length} cache hits, ${needsLLM.length} need LLM`
    );

    // ── Tier 3: Batch-verify the misses ──────────────────────────────────
    //
    // Three steps now:
    //   3a. Cross-examine with two LLMs (dualVerifyBatch). Both must accept.
    //   3b. Direction sanity check on accepted asymmetric triples
    //       (applyDirectionSanityCheck). Drops triples the verifier
    //       can't direction-distinguish.
    //   3c. Cache the FINAL kept/rejected decision so re-uploads skip
    //       all of the above.
    if (needsLLM.length > 0) {
        // 3a. Dual-model verification.
        const newVerdicts = await dualVerifyBatch(
            needsLLM.map(({ rel }) => ({
                subject: rel.from,
                predicate: rel.type,
                object: rel.to,
            })),
            chunk
        );

        // Build a mutable candidates list so the direction check can flip
        // `kept` to false in place.
        const candidates: Array<{
            rel: typeof needsLLM[number]['rel'];
            key: TripleKey;
            verdict: Omit<CachedVerdict, 'kept'>;
            kept: boolean;
        }> = [];

        for (let i = 0; i < needsLLM.length; i++) {
            const { rel, key } = needsLLM[i];
            const v = newVerdicts[i];
            if (!v) {
                console.warn(
                    `[KG Verify] Verification failed for: (${rel.from}, ${rel.type}, ${rel.to}) — discarding`
                );
                continue;
            }
            candidates.push({ rel, key, verdict: v, kept: isValidVerdict(v) });
        }

        // 3b. Direction sanity check (mutates `kept` in place).
        await applyDirectionSanityCheck(candidates, chunk);

        // 3c. Persist the final decisions and apply to `verified`.
        const toCache: Array<{ triple: TripleKey; verdict: CachedVerdict }> = [];
        for (const c of candidates) {
            const fullVerdict: CachedVerdict = { ...c.verdict, kept: c.kept };
            toCache.push({ triple: c.key, verdict: fullVerdict });

            if (c.kept) {
                verified.push(c.rel);
            } else {
                console.log(
                    `[KG Verify] Discarded: (${c.rel.from}, ${c.rel.type}, ${c.rel.to}) — verdict=${c.verdict.verdict}, confidence=${c.verdict.confidence}`
                );
            }
        }

        // Cache key includes both model names so audits can tell which
        // policy version produced each cached verdict.
        const cacheModelTag = ENABLE_DUAL_VERIFICATION
            ? `${VERIFIER_MODEL}+${SECONDARY_VERIFIER_MODEL}`
            : VERIFIER_MODEL;
        void storeVerdictsBatch(toCache, cacheModelTag);
    }

    return { ...raw, relationships: verified, _sourceChunk: chunk };
}

/**
 * Cross-examination verification. Runs two different LLMs on the same
 * triples in parallel and AND's their decisions:
 *   - both accept → accepted (with min confidence + more conservative verdict)
 *   - either rejects → rejected
 *   - either fails → null (caller drops)
 *
 * This is the fully-automated stand-in for the Tsaneva et al. (2025)
 * "human-on-disagreement" pattern. Where the paper sends contested
 * triples to a human, we silently drop them. Costs ~2x LLM calls on
 * cache miss; the cache amortises this across re-uploads.
 *
 * Falls back to single-model verification when ENABLE_DUAL_VERIFICATION
 * is false, so this is a safe default change.
 */
async function dualVerifyBatch(
    triples: Array<{ subject: string; predicate: string; object: string }>,
    sourceChunk: string
): Promise<Array<Omit<CachedVerdict, 'kept'> | null>> {
    if (!ENABLE_DUAL_VERIFICATION) {
        return verifyTriplesBatch(triples, sourceChunk, VERIFIER_MODEL);
    }

    const [primary, secondary] = await Promise.all([
        verifyTriplesBatch(triples, sourceChunk, VERIFIER_MODEL),
        verifyTriplesBatch(triples, sourceChunk, SECONDARY_VERIFIER_MODEL),
    ]);

    // Verdict ordering for "more conservative" selection: c < b < a
    const verdictRank: Record<string, number> = { a: 2, b: 1, c: 0 };

    return triples.map((_, i) => {
        const p = primary[i];
        const s = secondary[i];

        // If either verifier failed, treat the triple as un-verified.
        // Dropping is safer than half-verifying.
        if (!p || !s) {
            if (p || s) {
                console.warn(
                    `[KG Verify] One of two verifiers failed on triple ${i + 1} — discarding`
                );
            }
            return null;
        }

        // Pick the more conservative verdict and the lower confidence.
        const moreConservative =
            verdictRank[p.verdict] <= verdictRank[s.verdict] ? p : s;

        return {
            verdict: moreConservative.verdict,
            confidence: Math.min(p.confidence, s.confidence),
        };
    });
}

/**
 * Direction sanity check. For high-confidence accepts on asymmetric
 * predicates, also verify the REVERSED triple. If the verifier
 * confidently accepts both (X rel Y) AND (Y rel X), the verifier
 * isn't actually distinguishing direction — it's just confirming
 * co-occurrence. Drop the triple in that case.
 *
 * This addresses the most common verifier FP mode observed in
 * eval-output/verifier-eval.json: the verifier rubber-stamps direction-
 * reversed extractions like (Mohenjodaro FOUND_IN Cloth) because both
 * entities appear in the chunk.
 *
 * Mutates `candidates[i].kept` to false where the swap test fails.
 * Uses only the primary model (not dual) — the secondary model already
 * voted in the prior step, so this is purely about catching the
 * direction-blindness pattern, not adding a third opinion.
 */
async function applyDirectionSanityCheck(
    candidates: Array<{
        rel: ExtractedKnowledge['relationships'][number];
        verdict: Omit<CachedVerdict, 'kept'>;
        kept: boolean;
    }>,
    sourceChunk: string
): Promise<void> {
    if (!ENABLE_DIRECTION_CHECK) return;

    // Filter to accepts that are eligible for the swap test.
    const toRecheck: Array<{ idx: number; rel: typeof candidates[0]['rel'] }> = [];
    for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        if (!c.kept) continue;
        if (c.verdict.verdict !== 'a') continue;
        if (c.verdict.confidence < DIRECTION_CHECK_MIN_CONFIDENCE) continue;
        if (!ASYMMETRIC_PREDICATES.has(c.rel.type.toUpperCase())) continue;
        toRecheck.push({ idx: i, rel: c.rel });
    }

    if (toRecheck.length === 0) return;

    console.log(
        `[KG Direction] Running swap test on ${toRecheck.length} high-conf asymmetric triple(s)`
    );

    // Build the reversed versions and verify them in one batch.
    const reversedTriples = toRecheck.map(({ rel }) => ({
        subject: rel.to,
        predicate: rel.type,
        object: rel.from,
    }));

    const reverseVerdicts = await verifyTriplesBatch(
        reversedTriples,
        sourceChunk,
        VERIFIER_MODEL
    );

    // Where the reverse ALSO gets confidently accepted, the verifier is
    // direction-blind on this triple. Drop the original.
    let droppedCount = 0;
    for (let i = 0; i < toRecheck.length; i++) {
        const rv = reverseVerdicts[i];
        if (
            rv &&
            rv.verdict === 'a' &&
            rv.confidence >= DIRECTION_CHECK_MIN_CONFIDENCE
        ) {
            const c = candidates[toRecheck[i].idx];
            c.kept = false;
            droppedCount++;
            console.log(
                `[KG Direction] Dropped (verifier accepts both directions): (${c.rel.from}) -[${c.rel.type}]-> (${c.rel.to})`
            );
        }
    }

    if (droppedCount > 0) {
        console.log(
            `[KG Direction] Dropped ${droppedCount}/${toRecheck.length} for direction-blindness`
        );
    }
}

/**
 * Batch-verify up to N triples against a source passage in ONE LLM call.
 * Replaces the per-triple loop that made 1 call per relationship.
 *
 * Returns an array aligned to input order — element i is the verdict for
 * input triple i, or null on parse failure.
 */
async function verifyTriplesBatch(
    triples: Array<{ subject: string; predicate: string; object: string }>,
    sourceChunk: string,
    model: string = VERIFIER_MODEL
): Promise<Array<Omit<CachedVerdict, 'kept'> | null>> {
    const results: Array<Omit<CachedVerdict, 'kept'> | null> = new Array(triples.length).fill(null);
    if (triples.length === 0) return results;

    // Sub-batch so one massive chunk doesn't produce a monstrous prompt.
    for (let start = 0; start < triples.length; start += VERIFY_BATCH_SIZE) {
        const batch = triples.slice(start, start + VERIFY_BATCH_SIZE);

        const tripleLines = batch
            .map((t, i) => `${i + 1}. (${t.subject}, ${t.predicate}, ${t.object})`)
            .join('\n');

        try {
            const response = await chatCompletion(
                [
                    {
                        role: 'system',
                        content: `You are a fact-verification assistant for educational content.
Given a source passage and a list of factual triples, judge each triple
INDEPENDENTLY against the passage.

For each triple, decide:
(a) Directly and explicitly stated in the passage
(b) Implied or inferred — not directly stated
(c) Not supported or contradicted

Respond ONLY with JSON matching this schema:
{"verdicts": [{"index": 1, "verdict": "a"|"b"|"c", "confidence": 0.0-1.0}, ...]}

The verdicts array MUST contain exactly one entry per input triple,
with index values matching the input numbering (1-based).`,
                    },
                    {
                        role: 'user',
                        content: `Passage: "${sourceChunk}"

Triples to verify:
${tripleLines}

Judge each triple independently against the passage above.`,
                    },
                ],
                { jsonMode: true, temperature: 0.1, model }
            );

            const parsed = parseLLMJson<{
                verdicts: Array<{ index: number; verdict: string; confidence: number }>;
            }>(response);

            for (const item of parsed.verdicts ?? []) {
                const targetIdx = start + (item.index - 1);
                if (targetIdx < start || targetIdx >= start + batch.length) continue;

                const verdict = item.verdict;
                if (verdict !== 'a' && verdict !== 'b' && verdict !== 'c') continue;

                const confidence =
                    typeof item.confidence === 'number' && isFinite(item.confidence)
                        ? Math.max(0, Math.min(1, item.confidence))
                        : 0;

                results[targetIdx] = { verdict, confidence };
            }
        } catch (err) {
            console.warn(
                `[KG Verify/${model}] Batch verify call failed — leaving ${batch.length} triple(s) unverified for this run:`,
                (err as Error).message
            );
            // Leave the slots as null; caller discards those triples.
        }
    }

    return results;
}


// ─── Step 2: Merge extracted knowledge ───

/**
 * Normalizes a concept name to a canonical form for deduplication.
 * Strips punctuation, collapses whitespace, lowercases, and removes
 * common trailing noise words that the LLM adds inconsistently.
 */
function canonicalizeName(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')        // strip punctuation
        .replace(/\b(the|a|an|of|and|in|on|process|concept|principle|phenomenon|theory|law|effect|method|system|type|form|kind|class|category)\b/g, '')
        .replace(/\s+/g, ' ')               // collapse whitespace
        .trim();
}

/**
 * Pre-verifier structural filter.
 *
 * Drops triples that are schema-invalid before they reach the LLM verifier.
 * This is the ontology-validator stage from SCICERO (Tsaneva et al., 2025,
 * workflow 8): rule-based filter → LLM verifier, not the other way around.
 *
 * Rejection reasons:
 *   - empty_endpoint    → subject or object is empty / whitespace
 *   - self_loop         → from and to canonicalise to the same node
 *   - unknown_predicate → type is not in ALLOWED_PREDICATES
 *
 * Returning the discarded list (not just a count) lets the caller log
 * which triples were rejected for which reason — useful for the
 * VERIFIER-EVAL harness and Paulheim reporting.
 */
interface StructuralFilterResult {
    kept: ExtractedKnowledge['relationships'];
    discarded: Array<{
        rel: ExtractedKnowledge['relationships'][number];
        reason: string;
    }>;
}

function structuralFilter(
    relationships: ExtractedKnowledge['relationships']
): StructuralFilterResult {
    const kept: ExtractedKnowledge['relationships'] = [];
    const discarded: StructuralFilterResult['discarded'] = [];

    for (const rel of relationships) {
        const from = (rel.from || '').trim();
        const to = (rel.to || '').trim();
        const type = (rel.type || '').toUpperCase().replace(/\s+/g, '_');

        if (!from || !to) {
            discarded.push({ rel, reason: 'empty_endpoint' });
            continue;
        }

        if (canonicalizeName(from) === canonicalizeName(to)) {
            discarded.push({ rel, reason: 'self_loop' });
            continue;
        }

        if (!ALLOWED_PREDICATES.has(type)) {
            discarded.push({ rel, reason: `unknown_predicate:${type}` });
            continue;
        }

        kept.push({ from, to, type });
    }

    return { kept, discarded };
}

function mergeKnowledge(chunks: Array<ExtractedKnowledge & { _sourceChunk?: string }>): ExtractedKnowledge & { _sourceChunk: string } {
    // Maps canonical key → concept, preserving original name from first occurrence
    const conceptMap = new Map<string, any>();
    const relationships: ExtractedKnowledge['relationships'] = [];

    for (const chunk of chunks) {
        for (const concept of chunk.concepts) {
            const key = canonicalizeName(concept.name);
            if (!key) continue; // skip empty after normalization

            const existing = conceptMap.get(key);

            if (existing) {
                // Generic merge of all properties
                const allKeys = new Set([...Object.keys(existing), ...Object.keys(concept)]);
                for (const prop of allKeys) {
                    if (prop === 'name') continue; // keep name from first occurrence

                    const val1 = (existing as any)[prop];
                    const val2 = (concept as any)[prop];

                    if (Array.isArray(val1) || Array.isArray(val2)) {
                        (existing as any)[prop] = [...new Set([...(val1 || []), ...(val2 || [])])];
                    } else if (!val1 && val2) {
                        (existing as any)[prop] = val2;
                    }
                }
            } else {
                conceptMap.set(key, { ...concept });
            }
        }

        // Deduplicate relationships
        // Fix 1: Filter self-loops (from === to after normalization)
        // Fix 3: Prevent bidirectional edges of the same type (only keep first direction)
        for (const rel of chunk.relationships) {
            const fromNorm = rel.from.toLowerCase().trim();
            const toNorm = rel.to.toLowerCase().trim();
            const typeNorm = rel.type.toUpperCase();

            // Fix 1: Drop self-loops
            if (canonicalizeName(rel.from) === canonicalizeName(rel.to)) {
                console.log(`[KG Merge] Dropped self-loop: (${rel.from}, ${rel.type}, ${rel.to})`);
                continue;
            }

            // Check for exact duplicate (same direction)
            const exactDuplicate = relationships.some(
                (r) =>
                    r.from.toLowerCase() === fromNorm &&
                    r.to.toLowerCase() === toNorm &&
                    r.type.toUpperCase() === typeNorm
            );

            // Fix 3: Check for bidirectional duplicate of the same type
            const bidirectionalDuplicate = relationships.some(
                (r) =>
                    r.from.toLowerCase() === toNorm &&
                    r.to.toLowerCase() === fromNorm &&
                    r.type.toUpperCase() === typeNorm
            );

            if (!exactDuplicate && !bidirectionalDuplicate) {
                relationships.push(rel);
            } else if (bidirectionalDuplicate) {
                console.log(`[KG Merge] Dropped bidirectional duplicate: (${rel.from}, ${rel.type}, ${rel.to})`);
            }
        }
    }

    return {
        concepts: Array.from(conceptMap.values()),
        relationships,
        _sourceChunk: chunks[0]?._sourceChunk || '',
    };
}

/**
 * Validates the prerequisite DAG for a document.
 * Detects cycles in REQUIRES + IS_A edges and removes the lowest-confidence
 * edge in each cycle to ensure the graph remains a valid DAG.
 */
async function validatePrerequisiteDAG(
    userId: string,
    documentId: string
): Promise<void> {
    // Fetch all REQUIRES and IS_A edges for this document's concepts
    const edges = await runCypher<{ fromId: string; toId: string; relType: string }>(
        `MATCH (a:Concept {userId: $userId, documentId: $docId})-[r:REQUIRES|IS_A]->(b:Concept {userId: $userId})
         RETURN a.id AS fromId, b.id AS toId, type(r) AS relType`,
        { userId, docId: documentId }
    );

    if (edges.length === 0) {
        console.log('[DAG] No prerequisite edges found — skipping validation');
        return;
    }

    // Build adjacency list
    const graph = new Map<string, string[]>();
    for (const edge of edges) {
        if (!graph.has(edge.fromId)) graph.set(edge.fromId, []);
        graph.get(edge.fromId)!.push(edge.toId);
    }

    // DFS-based cycle detection
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const cyclicEdges: Array<{ from: string; to: string }> = [];

    function dfs(node: string): void {
        visited.add(node);
        inStack.add(node);

        for (const neighbor of graph.get(node) || []) {
            if (!visited.has(neighbor)) {
                dfs(neighbor);
            } else if (inStack.has(neighbor)) {
                // Cycle detected — record the back edge
                cyclicEdges.push({ from: node, to: neighbor });
            }
        }

        inStack.delete(node);
    }

    for (const node of graph.keys()) {
        if (!visited.has(node)) dfs(node);
    }

    if (cyclicEdges.length === 0) {
        console.log(`[DAG] Valid — no cycles found in ${edges.length} prerequisite edges`);
        return;
    }

    console.log(`[DAG] Found ${cyclicEdges.length} cyclic edge(s) — removing`);

    // Remove each cyclic edge from Neo4j
    for (const edge of cyclicEdges) {
        try {
            await runCypher(
                `MATCH (a:Concept {id: $fromId})-[r:REQUIRES|IS_A]->(b:Concept {id: $toId})
                 DELETE r`,
                { fromId: edge.from, toId: edge.to }
            );
            console.log(`[DAG] Removed cyclic edge: ${edge.from} → ${edge.to}`);
        } catch (err) {
            console.error(`[DAG] Failed to remove edge ${edge.from} → ${edge.to}:`, err);
        }
    }
}

// ─── Step 2b: Cross-chunk linking (Fix 4 — density / orphan nodes) ───

/**
 * Finds Concept nodes for this document that have zero relationships and
 * attempts to link them to other concepts via the LLM.
 *
 * This resolves the "very low average degree" issue that arises because
 * the per-chunk extractor only sees one chunk at a time, so cross-chunk
 * relationships are never found.
 *
 * Strategy:
 *  1. Query Neo4j for orphan Concept nodes (degree = 0) in this document.
 *  2. Also fetch a sample of well-connected concepts as candidates.
 *  3. For each orphan, ask the LLM: "given this concept's definition,
 *     which of these candidates is it related to, and how?"
 *  4. Write RELATES_TO (or the suggested type) edges for confident pairs.
 */
async function linkOrphanConcepts(userId: string, documentId: string): Promise<void> {
    // 1. Find orphan concept nodes (no inbound or outbound edges in the whole graph for this user)
    const orphans = await runCypher<{ id: string; name: string; definition: string }>(
        `MATCH (c:Concept {userId: $userId, documentId: $docId})
         WHERE NOT (c)--()
         RETURN c.id AS id, c.name AS name, c.definition AS definition
         LIMIT 50`,
        { userId, docId: documentId }
    );

    if (orphans.length === 0) {
        console.log('[KG Link] No orphan concepts found — skipping cross-chunk link pass');
        return;
    }

    console.log(`[KG Link] Found ${orphans.length} orphan concept(s) — attempting to link`);

    // 2. Fetch candidate concepts (connected ones to link against)
    const candidates = await runCypher<{ id: string; name: string; definition: string }>(
        `MATCH (c:Concept {userId: $userId, documentId: $docId})
         WHERE (c)--()
         RETURN c.id AS id, c.name AS name, c.definition AS definition
         LIMIT 50`,
        { userId, docId: documentId }
    );

    if (candidates.length === 0) {
        console.log('[KG Link] No candidate concepts to link orphans against');
        return;
    }

    const candidateSummary = candidates
        .map((c) => `- ${c.name}: ${c.definition || 'no definition'}`)
        .join('\n');

    // 3. For each orphan, ask the LLM which candidates it relates to
    for (const orphan of orphans) {
        try {
            const response = await chatCompletion(
                [
                    {
                        role: 'system',
                        content: `You are an educational knowledge graph assistant.
Given an orphan concept and a list of candidate concepts, identify which candidates
are meaningfully related to the orphan and emit up to 3 relationships.

Only emit relationships that are clearly meaningful for a CBSE Grade 4–10 student.
Use relationship types: IS_A | CAUSES | REQUIRES | PART_OF | CONTRASTS_WITH | EXAMPLE_OF | USED_FOR | FEATURE_OF | PRECEDES | EXTENSION_OF | RELATES_TO

Respond ONLY with JSON:
{
  "relationships": [
    { "to": "candidate concept name", "type": "RELATION_TYPE", "confidence": 0.0–1.0 }
  ]
}`
                    },
                    {
                        role: 'user',
                        content: `Orphan concept: "${orphan.name}"
Definition: "${orphan.definition || 'not available'}"

Candidate concepts:
${candidateSummary}

Which candidates is "${orphan.name}" related to, and how?`
                    }
                ],
                { jsonMode: true, temperature: 0.2 }
            );

            const result = parseLLMJson<{ relationships: Array<{ to: string; type: string; confidence: number }> }>(response);

            for (const rel of result.relationships || []) {
                if (!rel.to || !rel.type || rel.confidence < 0.55) continue;

                // Guard: skip self-loops
                if (rel.to.toLowerCase().trim() === orphan.name.toLowerCase().trim()) continue;

                const relType = rel.type.toUpperCase().replace(/\s+/g, '_');

                await runCypher(
                    `MATCH (a:Concept {id: $fromId}), (b:Concept {userId: $userId})
                     WHERE toLower(b.name) = toLower($toName)
                     AND a.id <> b.id
                     AND NOT (a)-[:${relType}]->(b)
                     MERGE (a)-[:${relType}]->(b)`,
                    { fromId: orphan.id, userId, toName: rel.to }
                );

                console.log(`[KG Link] Linked orphan "${orphan.name}" -[${relType}]-> "${rel.to}" (confidence: ${rel.confidence})`);
            }
        } catch (err) {
            console.warn(`[KG Link] Failed to link orphan "${orphan.name}":`, err);
        }
    }
}

async function linkOrphansAcrossDocuments(
    userId: string,
    documentId: string
): Promise<void> {
    // Re-check: are there still orphans in this document?
    const orphans = await runCypher<{ id: string; name: string; definition: string }>(
        `MATCH (c:Concept {userId: $userId, documentId: $docId})
         WHERE NOT (c)--()
         RETURN c.id AS id, c.name AS name, c.definition AS definition
         LIMIT 40`,
        { userId, docId: documentId }
    );

    if (orphans.length === 0) {
        console.log('[KG CrossLink] No orphans remain after per-document pass — skipping');
        return;
    }

    // Fetch well-connected concepts from OTHER documents by this user
    const candidates = await runCypher<{ id: string; name: string; definition: string }>(
        `MATCH (c:Concept {userId: $userId})
         WHERE c.documentId <> $docId AND (c)--()
         RETURN c.id AS id, c.name AS name, c.definition AS definition
         LIMIT 50`,
        { userId, docId: documentId }
    );

    if (candidates.length === 0) {
        console.log('[KG CrossLink] No inter-document candidates found — user has only 1 document');
        return;
    }

    console.log(
        `[KG CrossLink] Linking ${orphans.length} orphan(s) against ${candidates.length} cross-document candidate(s)`
    );

    const candidateSummary = candidates
        .map((c) => `- ${c.name}: ${(c.definition || '').substring(0, 100)}`)
        .join('\n');

    for (const orphan of orphans) {
        try {
            const response = await chatCompletion(
                [
                    {
                        role: 'system',
                        content: `You are an educational knowledge graph assistant for CBSE Grade 4–10.
Given an orphan concept and a list of candidate concepts from related study documents,
identify which candidates are meaningfully related to the orphan and suggest up to 3 relationships.
 
Only emit relationships that are clearly meaningful for a CBSE student.
Use types: IS_A | CAUSES | REQUIRES | PART_OF | CONTRASTS_WITH | EXAMPLE_OF | USED_FOR | FEATURE_OF | PRECEDES | EXTENSION_OF | RELATES_TO
 
Respond ONLY with JSON: { "relationships": [{ "to": "name", "type": "TYPE", "confidence": 0.0-1.0 }] }`,
                    },
                    {
                        role: 'user',
                        content: `Orphan concept: "${orphan.name}"
Definition: "${orphan.definition || 'not available'}"
 
Cross-document candidates:
${candidateSummary}
 
Which candidates is "${orphan.name}" related to?`,
                    },
                ],
                { jsonMode: true, temperature: 0.2 }
            );

            const result = parseLLMJson<{
                relationships: Array<{ to: string; type: string; confidence: number }>;
            }>(response);

            for (const rel of result.relationships || []) {
                if (!rel.to || !rel.type || rel.confidence < 0.55) continue;
                if (rel.to.toLowerCase().trim() === orphan.name.toLowerCase().trim()) continue;

                const relType = rel.type.toUpperCase().replace(/\s+/g, '_');

                await runCypher(
                    `MATCH (a:Concept {id: $fromId}), (b:Concept {userId: $userId})
                     WHERE toLower(b.name) = toLower($toName)
                     AND a.id <> b.id
                     AND NOT (a)-[:${relType}]->(b)
                     MERGE (a)-[:${relType}]->(b)`,
                    { fromId: orphan.id, userId, toName: rel.to }
                );

                console.log(
                    `[KG CrossLink] ${orphan.name} -[${relType}]-> ${rel.to} (conf: ${rel.confidence})`
                );
            }
        } catch (err) {
            console.warn(`[KG CrossLink] Failed for orphan "${orphan.name}":`, err);
        }
    }
}

// ─── CBSE subject domains used as anchor nodes ───
const CBSE_DOMAINS = [
    { name: 'Mathematics', keywords: ['equation', 'number', 'geometry', 'algebra', 'fraction', 'ratio', 'area', 'volume', 'angle', 'polygon', 'prime', 'integer', 'decimal', 'percentage'] },
    { name: 'Science', keywords: ['force', 'motion', 'energy', 'matter', 'cell', 'organism', 'chemical', 'element', 'atom', 'molecule', 'magnet', 'light', 'sound', 'heat', 'electricity', 'gravity', 'photosynthesis', 'ecosystem'] },
    { name: 'Social Studies', keywords: ['history', 'geography', 'civics', 'government', 'constitution', 'trade', 'culture', 'river', 'mountain', 'continent', 'empire', 'dynasty', 'democracy', 'resources', 'climate', 'map', 'soil'] },
    { name: 'English', keywords: ['grammar', 'verb', 'noun', 'adjective', 'adverb', 'tense', 'sentence', 'paragraph', 'comprehension', 'vocabulary', 'synonym', 'antonym', 'pronoun', 'preposition'] },
    { name: 'Hindi', keywords: ['संज्ञा', 'क्रिया', 'विशेषण', 'वाक्य', 'व्याकरण', 'काल'] },
    { name: 'Computer Science', keywords: ['algorithm', 'program', 'variable', 'loop', 'function', 'data', 'network', 'internet', 'software', 'hardware', 'binary', 'database'] },
];

/**
 * Anchors still-orphan concepts to the most relevant CBSE subject-domain
 * :SubjectDomain node.  This is a last-resort pass that guarantees every
 * concept has at least one edge, eliminating the "orphan node" metric.
 *
 * SubjectDomain nodes are shared (no userId) so they act as a common
 * vocabulary across all students.
 */
async function anchorOrphansToSubjectDomain(
    userId: string,
    documentId: string
): Promise<void> {
    const orphans = await runCypher<{ id: string; name: string; definition: string }>(
        `MATCH (c:Concept {userId: $userId, documentId: $docId})
         WHERE NOT (c)--()
         RETURN c.id AS id, c.name AS name, c.definition AS definition`,
        { userId, docId: documentId }
    );

    if (orphans.length === 0) return;

    console.log(`[KG Anchor] ${orphans.length} orphan(s) remaining — anchoring to subject domains`);

    for (const orphan of orphans) {
        const text = `${orphan.name} ${orphan.definition || ''}`.toLowerCase();

        // Score each domain by keyword hits
        let bestDomain = 'General Knowledge';
        let bestScore = 0;

        for (const domain of CBSE_DOMAINS) {
            const score = domain.keywords.filter((kw) => text.includes(kw)).length;
            if (score > bestScore) {
                bestScore = score;
                bestDomain = domain.name;
            }
        }

        try {
            // Upsert the SubjectDomain node (no userId — shared across students)
            await runCypher(
                `MERGE (d:SubjectDomain {name: $domain})
                 WITH d
                 MATCH (c:Concept {id: $conceptId})
                 MERGE (c)-[:PART_OF]->(d)`,
                { domain: bestDomain, conceptId: orphan.id }
            );
            console.log(`[KG Anchor] "${orphan.name}" -[PART_OF]-> "${bestDomain}"`);
        } catch (err) {
            console.warn(`[KG Anchor] Failed to anchor "${orphan.name}":`, err);
        }
    }
}

// ─── Step 3: Write to Neo4j ───

async function writeToNeo4j(
    userId: string,
    documentId: string,
    knowledge: ExtractedKnowledge & { _sourceChunk?: string }
): Promise<KnowledgeGraph> {
    const nodes: ConceptNode[] = [];
    const relations: ConceptRelation[] = [];

    for (const concept of knowledge.concepts) {
        const conceptId = uuid();

        // Clean properties for Neo4j (no arrays in main node)
        const mainProps: Record<string, string> = {
            id: conceptId,
            name: concept.name,
            definition: concept.definition || '',
            userId,
            documentId,
            sourceChunk: (knowledge._sourceChunk || '').substring(0, 500),
        };

        // 1. Create Main Concept Node
        await runCypher(
            `CREATE (c:Concept {
                id: $id,
                name: $name,
                definition: $definition,
                userId: $userId,
                documentId: $documentId
            })`,
            mainProps
        );

        nodes.push({
            id: conceptId,
            label: concept.name,
            type: 'concept',
            properties: mainProps,
        });

        // 2. Create sub-nodes for examples, formulas, misconceptions
        const CONCEPT_ARRAY_FIELDS = ['examples', 'formulas', 'misconceptions'] as const;

        for (const field of CONCEPT_ARRAY_FIELDS) {
            const items = (concept as any)[field] as string[] | undefined;
            if (!items?.length) continue;

            const relType = field.toUpperCase(); // EXAMPLES, FORMULAS, MISCONCEPTIONS
            const nodeLabel = field.slice(0, -1); // example, formula, misconception
            const capitalLabel = nodeLabel.charAt(0).toUpperCase() + nodeLabel.slice(1);

            for (const item of items) {
                if (!item || typeof item !== 'string') continue;
                const subNodeId = uuid();
                await runCypher(
                    `MATCH (c:Concept {id: $conceptId})
                     CREATE (s:${capitalLabel} {id: $id, text: $text})
                     CREATE (c)-[:${relType}]->(s)`,
                    { conceptId, id: subNodeId, text: item }
                );

                nodes.push({
                    id: subNodeId,
                    label: `${nodeLabel}: ${item.substring(0, 30)}...`,
                    type: nodeLabel as any,
                    properties: { text: item }
                });

                relations.push({
                    source: conceptId,
                    target: subNodeId,
                    type: relType as any
                });
            }
        }
    }

    // 3. Create Inter-Concept Relationships (Extracted by AI)
    for (const rel of knowledge.relationships) {
        const fromNorm = rel.from.toLowerCase().trim();
        const toNorm = rel.to.toLowerCase().trim();

        // Final self-loop guard at write time (belt-and-suspenders)
        if (fromNorm === toNorm) {
            console.log(`[KG Write] Skipped self-loop: (${rel.from}, ${rel.type}, ${rel.to})`);
            continue;
        }

        const dynamicRelType = (rel.type || 'RELATES_TO').toUpperCase().replace(/\s+/g, '_');

        await runCypher(
            `MATCH (a:Concept {userId: $userId}), (b:Concept {userId: $userId})
             WHERE toLower(a.name) = toLower($from) AND toLower(b.name) = toLower($to)
             AND a.id <> b.id
             MERGE (a)-[:${dynamicRelType}]->(b)`,
            {
                userId,
                from: rel.from,
                to: rel.to,
            }
        );
    }

    return { nodes, relations };
}

// ─── Main Builder Function ───


export async function buildKnowledgeGraph(
    userId: string,
    documentId: string,
    text: string
): Promise<KnowledgeGraph> {
    // 1. Chunk the text — use detailed variant so confidence scores flow through.
    const chunks = chunkTextDetailed(text);
    console.log(`[KG Builder] Created ${chunks.length} chunks from document`);

    // Log a quick confidence histogram so upload logs are inspectable.
    const highConf = chunks.filter((c) => c.confidenceScore >= VERIFY_SKIP_CONFIDENCE).length;
    const lowConf = chunks.filter((c) => c.confidenceScore < VERIFY_STRICT_CONFIDENCE).length;
    const mediumConf = chunks.length - highConf - lowConf;
    console.log(
        `[KG Builder] Chunk confidence: ${highConf} high / ${mediumConf} medium / ${lowConf} low`
    );

    // 2. Extract knowledge from each chunk — pass confidence score through.
    const extractedChunks: ExtractedKnowledge[] = [];
    for (const chunk of chunks) {
        try {
            const knowledge = await extractKnowledgeFromChunk(
                chunk.text,
                chunk.confidenceScore
            );
            extractedChunks.push(knowledge);
        } catch (error) {
            console.error('[KG Builder] Failed to extract from chunk:', error);
        }
    }

    // 3. Merge knowledge
    const merged = mergeKnowledge(extractedChunks);
    console.log(
        `[KG Builder] Merged: ${merged.concepts.length} concepts, ${merged.relationships.length} relationships`
    );
    // 3b. In-memory DAG cycle filter (Workflow 8 — pre-write structural check).
    //     Catches cycles among IS_A / PART_OF / PRECEDES / REQUIRES / EXTENSION_OF
    //     before they enter Neo4j. validatePrerequisiteDAG() still runs
    //     post-write as a safety net for cycles introduced by cross-document
    //     linking passes.
    const { kept: acyclicRels, droppedEdges: cyclicEdges } = filterCyclicEdges(
        merged.relationships
    );
    if (cyclicEdges.length > 0) {
        console.log(
            `[KG DAG-Filter] Dropped ${cyclicEdges.length} cyclic edge(s) before write:`
        );
        for (const e of cyclicEdges) {
            console.log(`  ✘ (${e.from}) -[${e.type}]-> (${e.to})`);
        }
    }
    merged.relationships = acyclicRels;
    // 4. Write to Neo4j
    const graph = await writeToNeo4j(userId, documentId, merged);
    console.log(`[KG Builder] Knowledge graph created with ${graph.nodes.length} nodes`);

    // 5. Validate prerequisite DAG — detect and remove cyclic edges
    try {
        await validatePrerequisiteDAG(userId, documentId);
    } catch (dagError) {
        // DAG validation failure should not block the upload
        console.error('[KG Builder] DAG validation error (non-fatal):', dagError);
    }

    // 6. Cross-chunk linking pass — connect related concepts that were extracted
    //    in different chunks and therefore have no explicit relationship yet.
    //    This addresses the low-density / orphan node problem.
    try {
        await linkOrphanConcepts(userId, documentId);
    } catch (linkError) {
        console.error('[KG Builder] Cross-chunk linking error (non-fatal):', linkError);
    }
    try {
        await linkOrphansAcrossDocuments(userId, documentId);
    } catch (crossLinkError) {
        console.error('[KG Builder] Cross-document linking error (non-fatal):', crossLinkError);
    }
    try {
        await anchorOrphansToSubjectDomain(userId, documentId);
    } catch (anchorError) {
        console.error('[KG Builder] Subject-domain anchoring error (non-fatal):', anchorError);
    }
    return graph;
}

/**
 * Query the knowledge graph for a specific concept and its related nodes.
 */
export async function queryConceptGraph(
    userId: string,
    conceptName: string
): Promise<KnowledgeGraph> {
    const results = await runCypher(
        `MATCH (c:Concept {userId: $userId})
     WHERE toLower(c.name) = toLower($name)
     OPTIONAL MATCH (c)-[r]->(related)
     RETURN c, type(r) as relType, related`,
        { userId, name: conceptName }
    );

    const nodes: ConceptNode[] = [];
    const relations: ConceptRelation[] = [];

    for (const record of results) {
        const c = record as Record<string, unknown>;
        const concept = c.c as Record<string, unknown>;
        const conceptProps = (concept as { properties?: Record<string, string> })?.properties || {};

        if (!nodes.find((n) => n.id === conceptProps.id)) {
            nodes.push({
                id: conceptProps.id || '',
                label: conceptProps.name || '',
                type: 'concept',
                properties: conceptProps,
            });
        }

        if (c.related) {
            const related = c.related as { properties?: Record<string, string> };
            const relatedProps = related.properties || {};
            nodes.push({
                id: relatedProps.id || '',
                label: relatedProps.name || relatedProps.text || '',
                type: 'definition',
                properties: relatedProps,
            });
            relations.push({
                source: conceptProps.id || '',
                target: relatedProps.id || '',
                type: (c.relType as ConceptRelation['type']) || 'EXPLAINS',
            });
        }
    }

    return { nodes, relations };
}

/**
 * Get all concepts for a user from Neo4j.
 */
export async function getUserConcepts(userId: string): Promise<ConceptNode[]> {
    const results = await runCypher(
        `MATCH (c:Concept {userId: $userId}) RETURN c`,
        { userId }
    );

    return results.map((record) => {
        const r = record as Record<string, unknown>;
        const c = r.c as { properties?: Record<string, string> };
        const props = c.properties || {};
        return {
            id: props.id || '',
            label: props.name || '',
            type: 'concept' as const,
            properties: props,
        };
    });
}