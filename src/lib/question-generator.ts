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

/**
 * Question Generator
 *
 * Generates questions from the Knowledge Graph using LLM.
 * 5 Question Types × 3 Difficulty Levels
 *
 * Distractor selection order:
 *   1. Graph-hop distractors (primary) — topology-grounded, difficulty from graph
 *   2. LLM-generated options (fallback) — when graph can't supply ≥3 distractors
 */

// ─── Get concept context from Neo4j ───

export async function getConceptContext(conceptId: string): Promise<string> {
    try {
        const results = await runCypher(
            `MATCH (c:Concept {documentId: $docId})
         OPTIONAL MATCH (c)-[:EXPLAINS]->(d:Definition)
         OPTIONAL MATCH (c)-[:HAS_EXAMPLE]->(e:Example)
         OPTIONAL MATCH (c)-[:PREREQUISITE]->(p:Concept)
         OPTIONAL MATCH (c)-[:CAUSES_CONFUSION_WITH]->(m)
         RETURN c.name as name, c.definition as definition,
                collect(DISTINCT d.text) as definitions,
                collect(DISTINCT e.text) as examples,
                collect(DISTINCT p.name) as prerequisites,
                collect(DISTINCT m.text) as misconceptions`,
            { docId: conceptId }
        );

        if (results.length === 0) return '';

        const allContext = results.map((r) => {
            const rec = r as Record<string, unknown>;
            return {
                name: rec.name,
                definition: rec.definition,
                definitions: rec.definitions,
                examples: rec.examples,
                prerequisites: rec.prerequisites,
                misconceptions: rec.misconceptions,
            };
        });

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

// ─── Generate a single question ───

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
                // userId is not in QuestionGenerationRequest — extract from concept_id context
                // We query by documentId so pass concept_id as documentId
                '', // userId — empty falls back gracefully inside buildGraphDistractors
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
    const context = await getConceptContext(conceptId);
    let count = getQuestionCount(context, mode);
    const questions: Question[] = [];

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
                            const sq = await generateQuestion({
                                concept_id: sc.concept_id,
                                concept_title: sTitle,
                                type: 'recall',
                                difficulty: 2,
                                context: sContext,
                            });
                            (sq as any)._is_spaced = true;
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

    for (let i = 0; i < configs.length; i++) {
        try {
            const q = await generateQuestion({
                concept_id: conceptId,
                concept_title: conceptTitle,
                type: configs[i].type,
                difficulty: configs[i].difficulty,
                context,
            });
            questions.push(q);
        } catch (error) {
            console.error(`[QGen] Failed to generate question ${i + 1} after retries:`, (error as Error).message);
        }
    }

    return questions.sort(() => Math.random() - 0.5);
}

// Keep backward compatibility
export async function generateDiagnosticQuestions(
    conceptId: string,
    conceptTitle: string,
    count: number = 5
): Promise<Question[]> {
    return generateQuestionsForMode(conceptId, conceptTitle, 'diagnostic');
}

export async function generateAssessmentQuestions(
    conceptId: string,
    conceptTitle: string,
    type: QuestionType,
    difficulty: DifficultyLevel,
    count: number = 1
): Promise<Question[]> {
    const context = await getConceptContext(conceptId);
    const questions: Question[] = [];

    for (let i = 0; i < count; i++) {
        try {
            const q = await generateQuestion({
                concept_id: conceptId,
                concept_title: conceptTitle,
                type,
                difficulty,
                context,
            });
            questions.push(q);
        } catch (error) {
            console.error(`[QGen] Failed to generate assessment question:`, (error as Error).message);
        }
    }

    return questions;
}