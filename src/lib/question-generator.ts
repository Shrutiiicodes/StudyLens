import { chatCompletion, parseLLMJson } from './groq';
import { runCypher } from './neo4j';
import { Question, QuestionType, DifficultyLevel, QuestionGenerationRequest } from '@/types/question';
import { AssessmentMode } from '@/types/student';
import { COGNITIVE_LEVEL_MAP, QUESTION_LIMITS } from '@/config/constants';
import { v4 as uuid } from 'uuid';
import { supabase } from './supabase';
import { needsSpacedReinforcement } from './forgetting-model';
import { PROMPTS } from '@/config/prompts';
import {
    buildGraphDistractors,
    selectDistractors,
} from './distractor-engine';
import {
    samplePoolQuestion,
    persistToPool,
    recordExposures,
    hashContext,
    type PoolKey,
    type PoolQuestion,
} from './question-pool';

/**
 * Question Generator
 *
 * Generates questions from the Knowledge Graph using LLM.
 * 5 Question Types × 3 Difficulty Levels
 *
 * Caching layer (question_pool table):
 *   1. Sample from the per-concept pool first — no LLM call on a hit.
 *   2. On miss, generate via LLM and persist to the pool for next time.
 *   3. Mastery-mode weak-spot reinforcement questions are user-specific and
 *      always go straight to the LLM (skipPool = true).
 *
 * Distractor selection order (unchanged):
 *   1. Graph-hop distractors (primary) — topology-grounded, difficulty from graph
 *   2. LLM-generated options (fallback) — when graph can't supply ≥3 distractors
 */

// ─── Get concept context from Neo4j ───
export async function getConceptContext(conceptId: string): Promise<string> {
    try {
        // Pull concepts + their outgoing relationships from the current KG schema.
        // The Concept nodes are stored with `documentId` pointing to the Supabase
        // concept record id (which is what we call conceptId in this codebase).
        const results = await runCypher(
            `MATCH (c:Concept {documentId: $docId})
             OPTIONAL MATCH (c)-[r]->(related:Concept)
             WITH c, collect(DISTINCT {
                relation: type(r),
                target: related.name,
                targetDef: related.definition
             }) AS relationships
             RETURN c.name AS name,
                    c.definition AS definition,
                    [x IN relationships WHERE x.target IS NOT NULL] AS relationships`,
            { docId: conceptId }
        );

        if (results.length === 0) {
            console.warn(`[QGen] No concepts found for documentId=${conceptId}`);
            return '';
        }

        const allContext = results.map((r) => {
            const rec = r as Record<string, unknown>;
            return {
                name: rec.name,
                definition: rec.definition,
                relationships: rec.relationships,
            };
        });

        console.log(`[QGen] Loaded ${allContext.length} concept(s) for context`);
        return JSON.stringify(allContext);
    } catch (error) {
        console.warn('[QGen] Neo4j unavailable, falling back to title-only context:', (error as Error).message);
        return '';
    }
}

// ─── Groq with retry ───

async function chatCompletionWithRetry(
    messages: Parameters<typeof chatCompletion>[0],
    options?: Parameters<typeof chatCompletion>[1],
    maxRetries = 3
): Promise<string> {
    let lastError: Error = new Error('Unknown error');

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await chatCompletion(messages, options);
        } catch (err) {
            lastError = err as Error;
            const msg = lastError.message.toLowerCase();
            const isRateLimit = msg.includes('429') || msg.includes('rate') || msg.includes('limit');
            const isTransient = msg.includes('timeout') || msg.includes('network') || msg.includes('503');

            if (attempt === maxRetries) break;

            if (isRateLimit || isTransient) {
                const delay = Math.pow(2, attempt) * 1000;
                console.warn(`[QGen] Groq ${isRateLimit ? 'rate limit' : 'transient error'} (attempt ${attempt}/${maxRetries}). Retrying in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
            } else {
                break;
            }
        }
    }

    throw lastError;
}

// ─── Generate a single question (pure LLM — no pool) ───

/**
 * Generate a single question via LLM. This function does NOT consult the
 * question pool — it's the "always regenerate" path used by:
 *   - pool misses in generateOrSampleQuestion
 *   - mastery-mode weak-spot reinforcement (user-specific context)
 *   - spaced-review for concepts without a populated pool
 */
export async function generateQuestion(request: QuestionGenerationRequest): Promise<Question> {
    const context = request.context !== undefined
        ? request.context
        : (await getConceptContext(request.concept_id));

    const difficultyLabel = { 1: 'Easy', 2: 'Medium', 3: 'Hard' }[request.difficulty];
    const typeDescription = request.type.toUpperCase();

    const response = await chatCompletionWithRetry(
        [
            {
                role: 'system',
                content: PROMPTS.QUESTION_GENERATOR.system(typeDescription, difficultyLabel),
            },
            {
                role: 'user',
                content: PROMPTS.QUESTION_GENERATOR.user(request.concept_title, context),
            },
        ],
        { jsonMode: true, temperature: 0.4 }
    );

    const parsed = parseLLMJson<{
        text: string;
        options: string[];
        correct_answer: string;
        explanation: string;
        cognitive_level?: number;
        bloom_level?: string;
    }>(response);

    const cognitiveLevelFromLLM = parsed.cognitive_level;
    const cognitiveLevelFromMap = COGNITIVE_LEVEL_MAP[request.type] || 1;
    const finalCognitiveLevel = (
        cognitiveLevelFromLLM &&
        cognitiveLevelFromLLM >= 1 &&
        cognitiveLevelFromLLM <= 4
    ) ? cognitiveLevelFromLLM : cognitiveLevelFromMap;

    // ── Start with LLM-generated question and options ─────────────────────
    let finalOptions = parsed.options || [];
    let finalDifficulty = request.difficulty;
    let distractorDistances: Record<string, number> | undefined;

    // ── Attempt graph-hop distractor upgrade ─────────────────────────────
    // Only attempt if we have a correct answer to build around
    if (parsed.correct_answer && request.concept_title) {
        try {
            const neighbours = await buildGraphDistractors(
                request.concept_title,
                request.user_id ?? '',
                request.concept_id
            );

            if (neighbours.length > 0) {
                const { distractors, difficulty, distanceMap } = selectDistractors(
                    request.concept_title,
                    neighbours,
                    parsed.correct_answer
                );

                if (distractors.length >= 3) {
                    // Graph supplied ≥3 valid distractors — use them
                    finalOptions = [...distractors, parsed.correct_answer]
                        .sort(() => Math.random() - 0.5);

                    // Override difficulty with graph-topology-derived value
                    finalDifficulty = (
                        difficulty === 'hard' ? 3 :
                            difficulty === 'easy' ? 1 : 2
                    ) as DifficultyLevel;

                    distractorDistances = distanceMap;

                    console.log(
                        `[QGen] Graph distractors used for "${request.concept_title}" — difficulty: ${difficulty}`
                    );
                } else {
                    console.log(
                        `[QGen] Only ${distractors.length} graph distractors found for "${request.concept_title}" — using LLM options`
                    );
                }
            }
        } catch (e) {
            // Non-fatal — LLM options are the fallback
            console.warn('[QGen] Graph distractor selection failed, using LLM options:', (e as Error).message);
        }
    }

    return {
        id: uuid(),
        concept_id: request.concept_id,
        concept_title: request.concept_title,
        type: request.type,
        format: 'mcq', // all generated questions are MCQ; set explicitly, never inferred
        difficulty: finalDifficulty,
        text: parsed.text,
        options: finalOptions,
        correct_answer: parsed.correct_answer,
        explanation: parsed.explanation,
        cognitive_level: finalCognitiveLevel,
        bloom_level: parsed.bloom_level as any,
        distractor_distances: distractorDistances,
    };
}


// ─── Generate OR sample (pool-first path) ───

interface GenerateOrSampleOptions {
    /** Skip the pool entirely — use this for user-specific prompts. */
    skipPool?: boolean;
    /** Pool IDs already served in this session; don't deal them again. */
    dealtPoolIds: Set<string>;
    /** Accumulator for exposures to record at end of session. */
    exposures: Array<{ poolQuestionId: string; conceptId: string }>;
}

/**
 * Pool-first question generation.
 *   1. If skipPool is false, try to sample from the pool.
 *   2. Otherwise (or on miss) generate via LLM and persist.
 *
 * Either way, the returned Question has all the same fields as
 * generateQuestion() produces — callers don't care whether it came from
 * the pool or was freshly generated.
 */
async function generateOrSampleQuestion(
    request: QuestionGenerationRequest,
    opts: GenerateOrSampleOptions
): Promise<Question> {
    const poolKey: PoolKey = {
        conceptId: request.concept_id,
        type: request.type,
        difficulty: request.difficulty,
    };

    // ── 1. Pool sample ───────────────────────────────────────────────────
    if (!opts.skipPool) {
        const sampled = await samplePoolQuestion(poolKey, request.user_id, opts.dealtPoolIds);
        if (sampled) {
            opts.dealtPoolIds.add(sampled.pool_id!);
            opts.exposures.push({
                poolQuestionId: sampled.pool_id!,
                conceptId: request.concept_id,
            });
            console.log(
                `[QGen] Pool hit: ${request.type}/${request.difficulty} for concept ${request.concept_id.slice(0, 8)}`
            );
            // Strip the internal pool_id field before returning to the caller
            const { pool_id: _pool_id, ...q } = sampled as PoolQuestion;
            void _pool_id;
            return q as Question;
        }
    }

    // ── 2. LLM generation ───────────────────────────────────────────────
    const generated = await generateQuestion(request);

    // ── 3. Persist to pool if this was a cacheable generation ───────────
    //     When we persist, we also rewrite the question's id to the stable
    //     pool_<row_id> form. That way, whether this exact question came
    //     from the pool now or in a future session, it carries the SAME
    //     question_id — so the IRT endpoint aggregates response stats
    //     across all students correctly.
    //
    //     skipPool = user-specific prompt, don't pollute the shared pool.
    if (!opts.skipPool) {
        const contextHash = hashContext(request.context ?? '');
        const poolId = await persistToPool(poolKey, generated, contextHash);
        if (poolId) {
            generated.id = `pool_${poolId}`;
            opts.dealtPoolIds.add(poolId);
            if (request.user_id) {
                opts.exposures.push({
                    poolQuestionId: poolId,
                    conceptId: request.concept_id,
                });
            }
            console.log(
                `[QGen] Pool miss → generated + cached: ${request.type}/${request.difficulty}`
            );
        }
    }

    return generated;
}

// ─── Question count based on context richness ───

function getQuestionCount(context: string, mode: AssessmentMode): number {
    const limits = (QUESTION_LIMITS as Record<string, { min: number; max: number }>)[mode as string]
        ?? { min: 5, max: 10 };

    let conceptCount = 1;
    try {
        const parsed = JSON.parse(context);
        if (Array.isArray(parsed)) {
            conceptCount = Math.max(1, parsed.length);
        }
    } catch {
        // Not structured JSON — use minimum
    }

    const raw = conceptCount * 2;
    return Math.max(limits.min, Math.min(raw, limits.max));
}

// ─── Question configs per mode ───

function getConfigsForMode(
    mode: AssessmentMode,
    count: number,
    currentMastery: number = 50
): Array<{ type: QuestionType; difficulty: DifficultyLevel }> {
    const types: QuestionType[] = ['recall', 'conceptual', 'application', 'reasoning', 'analytical'];
    const configs: Array<{ type: QuestionType; difficulty: DifficultyLevel }> = [];

    for (let i = 0; i < count; i++) {
        const type = types[i % types.length];
        let difficulty: DifficultyLevel;

        switch (mode) {
            case 'diagnostic':
                difficulty = (i < count / 3 ? 1 : i < (count * 2) / 3 ? 2 : 3) as DifficultyLevel;
                break;

            case 'practice':
            case 'mastery': {
                const m = Math.max(0, Math.min(100, currentMastery));
                const easy = Math.max(0, 0.7 - 0.006 * m);
                const medium = 0.3 + 0.002 * m;
                const hard = Math.max(0, 1 - (easy + medium));
                const total = easy + medium + hard;
                const rand = Math.random();

                if (rand < easy / total) difficulty = 1;
                else if (rand < (easy + medium) / total) difficulty = 2;
                else difficulty = 3;

                if (mode === 'mastery' && difficulty === 1 && Math.random() > 0.4) difficulty = 2;
                break;
            }

            default:
                difficulty = 2;
        }

        configs.push({ type, difficulty });
    }

    return configs;
}

// ─── Main: Generate questions for a mode ───

export async function generateQuestionsForMode(
    conceptId: string,
    conceptTitle: string,
    mode: AssessmentMode = 'diagnostic',
    currentMastery: number = 50,
    userId?: string
): Promise<Question[]> {
    let context = await getConceptContext(conceptId);
    let count = getQuestionCount(context, mode);
    const questions: Question[] = [];

    // Per-session bookkeeping for the pool:
    //  - dealtPoolIds: prevents dealing the same pool row twice this session
    //  - exposures: batched write at the end of generation
    const dealtPoolIds = new Set<string>();
    const exposures: Array<{ poolQuestionId: string; conceptId: string }> = [];

    // ── SPACED REPETITION INJECTION ───────────────────────────────────────
    if (userId && (mode === 'practice' || mode === 'mastery')) {
        try {
            const { data: currentConcept } = await supabase
                .from('concepts')
                .select('source_document')
                .eq('id', conceptId)
                .single();

            const sourceDoc = currentConcept?.source_document;

            const { data: records } = await supabase
                .from('mastery')
                .select('concept_id, mastery_score, last_updated, concepts(title, source_document)')
                .eq('user_id', userId)
                .neq('concept_id', conceptId);

            if (records && records.length > 0) {
                const sameDocRecords = sourceDoc
                    ? records.filter(r => {
                        const c = r.concepts as unknown as { source_document?: string } | null;
                        return c?.source_document === sourceDoc;
                    })
                    : records;

                const spacedConcepts = sameDocRecords.filter(r =>
                    needsSpacedReinforcement(r.mastery_score, r.last_updated)
                );

                if (spacedConcepts.length > 0) {
                    const maxSpaced = mode === 'mastery' ? 2 : 1;
                    const toSpace = spacedConcepts
                        .sort(() => 0.5 - Math.random())
                        .slice(0, Math.min(maxSpaced, Math.floor(count / 2)));

                    for (const sc of toSpace) {
                        const sContext = await getConceptContext(sc.concept_id);
                        const sTitle = (sc.concepts as any)?.title || 'Review Concept';
                        try {
                            // Spaced questions go through the pool path — if
                            // the other concept's pool is populated, this
                            // costs zero LLM calls.
                            const sq = await generateOrSampleQuestion(
                                {
                                    concept_id: sc.concept_id,
                                    concept_title: sTitle,
                                    type: 'recall',
                                    difficulty: 2,
                                    context: sContext,
                                    user_id: userId,
                                },
                                { dealtPoolIds, exposures }
                            );
                            sq.is_spaced = true;
                            questions.push(sq);
                            count--;
                        } catch (e) {
                            console.warn('[QGen] Spaced question failed, skipping:', e);
                        }
                    }
                }
            }
        } catch (e) {
            console.error('[QGen] Spaced Injection Failed:', e);
        }
    }

    // ── Generate main session questions ───────────────────────────────────
    const configs = getConfigsForMode(mode, count, currentMastery);

    // Mastery mode: determine whether the first question should be a
    // user-specific "weak-spot reinforcement" question (always LLM).
    // If so, we carve it off and serve the rest from the pool.
    let weakSpotContext: string | null = null;
    if (mode === 'mastery' && userId) {
        const { data: weakSpots } = await supabase
            .from('attempts')
            .select('question_text, correct_answer')
            .eq('user_id', userId)
            .eq('concept_id', conceptId)
            .eq('correct', false)
            .not('question_text', 'is', null)
            .order('created_at', { ascending: false })
            .limit(3);

        if (weakSpots && weakSpots.length > 0) {
            weakSpotContext = context + '\n\n[REINFORCE THESE GAPS]\n' +
                weakSpots
                    .map(w => `Previously missed: "${w.question_text}" — correct answer: "${w.correct_answer}"`)
                    .join('\n');
        }
    }
    // ── Pick a diverse subset of concepts for question generation ─────────
    // Different questions must focus on different parts of the KG, otherwise
    // the LLM just picks the most salient relationship every time.
    type ContextConcept = {
        name: string;
        definition: string;
        relationships: Array<{ relation: string; target: string; targetDef: string }>;
    };

    let parsedContext: ContextConcept[] = [];
    try {
        parsedContext = JSON.parse(context);
    } catch {
        parsedContext = [];
    }

    // Prefer concepts that HAVE relationships (richer context for question gen)
    const richConcepts = parsedContext.filter(c => (c.relationships?.length ?? 0) > 0);
    const pool = richConcepts.length >= configs.length ? richConcepts : parsedContext;

    // Shuffle so each session doesn't pick the same 5 concepts
    const shuffled = [...pool].sort(() => Math.random() - 0.5);

    /** Return a focused context JSON for the i-th question. */
    function getFocusedContext(i: number): { title: string; context: string } {
        if (shuffled.length === 0) {
            return { title: conceptTitle, context };  // fallback: full context
        }
        const primary = shuffled[i % shuffled.length];
        // Include the primary concept + the top-level concept for grounding
        const topLevel = parsedContext.find(c =>
            c.name.toLowerCase() === conceptTitle.toLowerCase()
        );
        const slice = topLevel && topLevel !== primary
            ? [primary, topLevel]
            : [primary];
        return {
            title: primary.name,
            context: JSON.stringify(slice),
        };
    }
    for (let i = 0; i < configs.length; i++) {
        try {
            const isUserSpecific = i === 0 && weakSpotContext !== null;
            const focused = getFocusedContext(i);

            const q = await generateOrSampleQuestion(
                {
                    concept_id: conceptId,
                    concept_title: isUserSpecific ? conceptTitle : focused.title,
                    type: configs[i].type,
                    difficulty: configs[i].difficulty,
                    context: isUserSpecific ? weakSpotContext! : focused.context,
                    user_id: userId,
                },
                {
                    dealtPoolIds,
                    exposures,
                    skipPool: isUserSpecific,
                }
            );
            questions.push(q);
        } catch (error) {
            console.error(`[QGen] Failed to generate question ${i + 1} after retries:`, (error as Error).message);
        }
    }

    // ── Batch-record exposures ───────────────────────────────────────────
    if (userId && exposures.length > 0) {
        void recordExposures(userId, exposures);
    }

    // Dedupe by normalized question text — catches near-identical questions
    // that survive pool-ID dedup (LLM regenerates similar text on cache miss)
    const seen = new Set<string>();
    const deduped = questions.filter(q => {
        const key = q.text.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
        if (seen.has(key)) {
            console.log(`[QGen] Filtered duplicate: "${q.text.slice(0, 60)}..."`);
            return false;
        }
        seen.add(key);
        return true;
    });

    return deduped.sort(() => Math.random() - 0.5);
}

export async function generateAssessmentQuestions(
    conceptId: string,
    conceptTitle: string,
    type: QuestionType,
    difficulty: DifficultyLevel,
    count: number = 1,
    userId?: string,
): Promise<Question[]> {
    const context = await getConceptContext(conceptId);
    const questions: Question[] = [];

    // This helper is called in ad-hoc contexts — give it the pool path too.
    const dealtPoolIds = new Set<string>();
    const exposures: Array<{ poolQuestionId: string; conceptId: string }> = [];

    for (let i = 0; i < count; i++) {
        try {
            const q = await generateOrSampleQuestion(
                {
                    concept_id: conceptId,
                    concept_title: conceptTitle,
                    type,
                    difficulty,
                    context,
                    user_id: userId,
                },
                { dealtPoolIds, exposures }
            );
            questions.push(q);
        } catch (error) {
            console.error(`[QGen] Failed to generate assessment question:`, (error as Error).message);
        }
    }

    if (userId && exposures.length > 0) {
        void recordExposures(userId, exposures);
    }

    return questions;
}