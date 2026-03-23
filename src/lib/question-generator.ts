import { chatCompletion, parseLLMJson } from './groq';
import { runCypher } from './neo4j';
import { Question, QuestionType, DifficultyLevel, QuestionGenerationRequest } from '@/types/question';
import { COGNITIVE_LEVEL_MAP } from '@/config/constants';
import { v4 as uuid } from 'uuid';
import { supabase } from './supabase';
import { needsSpacedReinforcement } from './forgetting-model';
/**
 * Question Generator
 * 
 * Generates questions from the Knowledge Graph using LLM.
 * 5 Question Types × 3 Difficulty Levels
 */

// ─── Get concept context from Neo4j ───

export async function getConceptContext(conceptId: string): Promise<string> {
    try {
        // conceptId here is the Supabase concept UUID which is stored as documentId in Neo4j
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

        // Combine context from all concept nodes in this document
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

import { PROMPTS } from '@/config/prompts';

// ─── Generate a single question ───

export async function generateQuestion(request: QuestionGenerationRequest): Promise<Question> {
    // Get concept context from KG (support empty strings when Neo4j fails)
    const context = request.context !== undefined ? request.context : (await getConceptContext(request.concept_id));

    const difficultyLabel = { 1: 'Easy', 2: 'Medium', 3: 'Hard' }[request.difficulty];
    const typeDescription = request.type.toUpperCase();

    const response = await chatCompletion(
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

    // Use LLM-provided cognitive_level if valid, otherwise fall back to map
    const cognitiveLevelFromLLM = parsed.cognitive_level;
    const cognitiveLevelFromMap = COGNITIVE_LEVEL_MAP[request.type] || 1;
    const finalCognitiveLevel = (
        cognitiveLevelFromLLM &&
        cognitiveLevelFromLLM >= 1 &&
        cognitiveLevelFromLLM <= 4
    ) ? cognitiveLevelFromLLM : cognitiveLevelFromMap;

    return {
        id: uuid(),
        concept_id: request.concept_id,
        type: request.type,
        difficulty: request.difficulty,
        text: parsed.text,
        options: parsed.options,
        correct_answer: parsed.correct_answer,
        explanation: parsed.explanation,
        cognitive_level: finalCognitiveLevel,
        bloom_level: parsed.bloom_level as any,
    };
}

// ─── Generate questions based on mode ───

type AssessmentMode = 'diagnostic' | 'practice' | 'mastery';

/**
 * Determine question count based on concept context richness.
 * More concepts in the knowledge graph = more questions.
 */
// Question count limits per mode — matches architecture spec
const QUESTION_LIMITS: Record<AssessmentMode, { min: number; max: number }> = {
    diagnostic: { min: 3, max: 5 },
    practice: { min: 3, max: 7 },
    mastery: { min: 5, max: 8 },
};

function getQuestionCount(context: string, mode: AssessmentMode): number {
    const limits = QUESTION_LIMITS[mode] ?? { min: 5, max: 10 };

    // Count concept nodes from structured context
    let conceptCount = 1;
    try {
        const parsed = JSON.parse(context);
        if (Array.isArray(parsed)) {
            conceptCount = Math.max(1, parsed.length);
        }
    } catch {
        // Context is not structured JSON — use minimum
    }

    // 2 questions per concept node, clamped to mode limits
    const raw = conceptCount * 2;
    return Math.max(limits.min, Math.min(raw, limits.max));
}

/**
 * Get question configs for each mode.
 * Each mode emphasizes different question types and difficulty levels.
 */
function getConfigsForMode(
    mode: AssessmentMode,
    count: number,
    currentMastery: number = 50  // ADD THIS PARAMETER
): Array<{ type: QuestionType; difficulty: DifficultyLevel }> {
    const types: QuestionType[] = ['recall', 'conceptual', 'application', 'reasoning', 'analytical'];
    const configs: Array<{ type: QuestionType; difficulty: DifficultyLevel }> = [];

    for (let i = 0; i < count; i++) {
        const type = types[i % types.length];
        let difficulty: DifficultyLevel;

        switch (mode) {
            case 'diagnostic':
                // Progressive difficulty regardless of mastery —
                // diagnostic purpose is to find the ceiling, not adapt to it
                difficulty = (i < count / 3 ? 1 : i < (count * 2) / 3 ? 2 : 3) as DifficultyLevel;
                break;

            case 'practice':
            case 'mastery': {
                // Use mastery-adaptive probability distribution
                // E(M) = max(0, 0.7 - 0.006M)
                // Med(M) = 0.3 + 0.002M
                // H(M) = 1 - (E + Med)
                const m = Math.max(0, Math.min(100, currentMastery));
                const easy = Math.max(0, 0.7 - 0.006 * m);
                const medium = 0.3 + 0.002 * m;
                const hard = Math.max(0, 1 - (easy + medium));
                const total = easy + medium + hard;

                const rand = Math.random();
                const easyProb = easy / total;
                const mediumProb = (easy + medium) / total;

                if (rand < easyProb) difficulty = 1;
                else if (rand < mediumProb) difficulty = 2;
                else difficulty = 3;

                // Mastery mode: enforce at least 60% medium/hard
                if (mode === 'mastery' && difficulty === 1 && Math.random() > 0.4) {
                    difficulty = 2;
                }
                break;
            }

            default:
                difficulty = 2;
        }

        configs.push({ type, difficulty });
    }

    return configs;
}

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

    // -- SPACED REPETITION INJECTION (SILENT) --
    if (userId && (mode === 'practice' || mode === 'mastery')) {
        try {
            const { data: records } = await supabase
                .from('mastery')
                .select('concept_id, mastery_score, last_updated, concepts(title)')
                .eq('user_id', userId)
                .neq('concept_id', conceptId);
            
            if (records && records.length > 0) {
                // Find concepts mathematically due for Spaced Revision
                const spacedConcepts = records.filter(r => needsSpacedReinforcement(r.mastery_score, r.last_updated));
                
                if (spacedConcepts.length > 0) {
                    const maxSpaced = mode === 'mastery' ? 2 : 1;
                    const toSpace = spacedConcepts.sort(() => 0.5 - Math.random()).slice(0, Math.min(maxSpaced, Math.floor(count / 2)));
                    
                    for (const sc of toSpace) {
                        const sContext = await getConceptContext(sc.concept_id);
                        const sTitle = (sc.concepts as any)?.title || 'Review Concept';
                        const sq = await generateQuestion({
                            concept_id: sc.concept_id,
                            concept_title: sTitle,
                            type: 'recall',
                            difficulty: 2,
                            context: sContext
                        });
                        questions.push(sq);
                        count--; // Trade a standard token generation slot for this spaced review slot
                    }
                }
            }
        } catch (e) {
            console.error('[QGen] Spaced Injection Failed', e);
        }
    }

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
            console.error(`[QGen] Failed to generate question ${i + 1}:`, error);
        }
    }

    // Return the dynamically assembled test completely shuffled so spaced concepts blend in natively
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

// ─── Generate questions for practice/mastery ───

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
            console.error(`[QGen] Failed to generate assessment question:`, error);
        }
    }

    return questions;
}

/**
 * Evaluate a summary using LLM rubric scoring.
 */
export async function evaluateSummary(
    conceptTitle: string,
    conceptContext: string,
    studentSummary: string
): Promise<{
    score: number;
    feedback: string;
    rubric: Record<string, number>;
}> {
    const response = await chatCompletion(
        [
            {
                role: 'system',
                content: `You are an expert evaluator for student summaries. 
Evaluate the student's summary of the concept against the source material.

Score on these rubric dimensions (each 0-5):
1. Accuracy: Are the facts correct?
2. Completeness: Are the key points covered?
3. Understanding: Does it show genuine understanding (not just parroting)?
4. Clarity: Is it clearly written?
5. Connections: Does it make connections to related concepts?

Respond in JSON:
{
  "score": <overall 0-100>,
  "feedback": "Encouraging feedback with specific suggestions",
  "rubric": {
    "accuracy": <0-5>,
    "completeness": <0-5>,
    "understanding": <0-5>,
    "clarity": <0-5>,
    "connections": <0-5>
  }
}`,
            },
            {
                role: 'user',
                content: `Concept: ${conceptTitle}\n\nSource Material:\n${conceptContext}\n\nStudent Summary:\n${studentSummary}`,
            },
        ],
        { jsonMode: true }
    );

    return parseLLMJson(response);
}
