import { chatCompletion, parseLLMJson } from './groq';
import { runCypher } from './neo4j';
import { Question, QuestionType, DifficultyLevel, QuestionGenerationRequest } from '@/types/question';
import { COGNITIVE_LEVEL_MAP } from '@/config/constants';
import { v4 as uuid } from 'uuid';

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
    // Get concept context from KG
    const context = request.context || (await getConceptContext(request.concept_id));

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
    }>(response);

    return {
        id: uuid(),
        concept_id: request.concept_id,
        type: request.type,
        difficulty: request.difficulty,
        text: parsed.text,
        options: parsed.options,
        correct_answer: parsed.correct_answer,
        explanation: parsed.explanation,
        cognitive_level: COGNITIVE_LEVEL_MAP[request.type] || 1,
    };
}

// ─── Generate questions based on mode ───

type AssessmentMode = 'diagnostic' | 'practice' | 'mastery' | 'spaced';

/**
 * Determine question count based on concept context richness.
 * More concepts in the knowledge graph = more questions.
 */
function getQuestionCount(context: string, mode: AssessmentMode): number {
    // Try to count concepts from context
    let conceptCount = 1;
    try {
        const parsed = JSON.parse(context);
        if (Array.isArray(parsed)) {
            conceptCount = parsed.length;
        }
    } catch {
        // No structured context, use minimum
    }

    // Base count on number of concepts: 2 questions per concept, min 5, max 15
    const baseCount = Math.max(5, Math.min(conceptCount * 2, 15));

    switch (mode) {
        case 'diagnostic':
            return Math.min(baseCount, 10); // Cap diagnostic at 10
        case 'practice':
            return baseCount;
        case 'mastery':
            return Math.max(baseCount, 8); // At least 8 for mastery
        case 'spaced':
            return Math.min(baseCount, 8); // Cap spaced at 8
        default:
            return 5;
    }
}

/**
 * Get question configs for each mode.
 * Each mode emphasizes different question types and difficulty levels.
 */
function getConfigsForMode(
    mode: AssessmentMode,
    count: number
): Array<{ type: QuestionType; difficulty: DifficultyLevel }> {
    const types: QuestionType[] = ['recall', 'conceptual', 'application', 'reasoning', 'analytical'];
    const configs: Array<{ type: QuestionType; difficulty: DifficultyLevel }> = [];

    for (let i = 0; i < count; i++) {
        const type = types[i % types.length];
        let difficulty: DifficultyLevel;

        switch (mode) {
            case 'diagnostic':
                // Progressive difficulty: easy → medium → hard
                difficulty = (i < count / 3 ? 1 : i < (count * 2) / 3 ? 2 : 3) as DifficultyLevel;
                break;
            case 'practice':
                // Mostly medium, some easy
                difficulty = (i % 3 === 0 ? 1 : 2) as DifficultyLevel;
                break;
            case 'mastery':
                // Mostly hard, some medium
                difficulty = (i % 3 === 0 ? 2 : 3) as DifficultyLevel;
                break;
            case 'spaced':
                // Mixed across all levels
                difficulty = ((i % 3) + 1) as DifficultyLevel;
                break;
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
    mode: AssessmentMode = 'diagnostic'
): Promise<Question[]> {
    const context = await getConceptContext(conceptId);
    const count = getQuestionCount(context, mode);
    const configs = getConfigsForMode(mode, count);
    const questions: Question[] = [];

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

    return questions;
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
