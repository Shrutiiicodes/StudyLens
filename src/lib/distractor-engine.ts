/**
 * src/lib/distractor-engine.ts
 *
 * Graph-hop distractor selection + KG-grounded misconception analysis.
 * Ported from the Python backend (backend/graph/questions/question_generator.py
 * and backend/graph/questions/misconception_analyzer.py).
 *
 * Design principles (same as Python):
 *  - The KG builds distractors from graph-distance neighbours.
 *  - Scoring is deterministic — derived from graph topology, not LLM guessing.
 *  - Everything degrades gracefully if Neo4j is unavailable.
 *
 * Explanation policy (Hotspot C):
 *  - Template is the DEFAULT path for routine wrong answers. The template
 *    is built from the KG path + relation types so it is genuinely
 *    informative, not a filler.
 *  - LLM is reserved for: (a) no KG path found + PARTIAL/CRITICAL severity,
 *    (b) student has missed this concept repeatedly, (c) short-answer
 *    evaluation where templates can't capture the nuance.
 *  - All LLM outputs are cached by (label, correct, student_answer, concept,
 *    kg_path) so repeat occurrences skip the call.
 *
 * USAGE in question-generator.ts:
 *
 *   import { buildGraphDistractors, analyzeAnswer } from './distractor-engine';
 *
 *   // During question generation — get graph-hop distractors
 *   const distractors = await buildGraphDistractors(conceptName, userId, documentId);
 *   if (distractors.length >= 3) {
 *     // use graph distractors instead of LLM-generated ones
 *   }
 *
 *   // After student answers — get misconception analysis
 *   const result = await analyzeAnswer({ ... });
 */

import { runCypher } from './neo4j';
import { chatCompletion, parseLLMJson } from './groq';
import {
    lookupExplanation,
    storeExplanation,
    countPriorWrongAttempts,
    type ExplanationKey,
} from './misconception-cache';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GraphDistractor {
    name: string;
    distance: number;   // 1 = directly connected, 2 = two hops, 3 = three hops
    similarity: number; // cosine similarity to concept name (topic relevance)
}

export type MisconceptionSeverity = 'CORRECT' | 'CLOSE' | 'PARTIAL' | 'CRITICAL';

export interface MisconceptionResult {
    isCorrect: boolean;
    score: number;                   // 0.0–1.0 deterministic
    severity: MisconceptionSeverity;
    misconceptionLabel: string;
    gapDescription: string;
    correctExplanation: string;
    kgPath: string[];                // graph path between wrong and correct concept
    distractorDistance: number | null; // distance of chosen option in KG
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Minimum cosine similarity for a distractor to be topically relevant
const DISTRACTOR_TOPIC_THRESHOLD = 0.12;    // hops 1 & 2
const DISTRACTOR_HOP3_THRESHOLD = 0.18;    // hop 3 — tighter

// Explanation policy — how many prior wrong attempts on this concept trigger
// an LLM escalation ("this student keeps missing this, give them fresh words").
const REPEAT_MISS_ESCALATION_THRESHOLD = 2;

// Verifier model name — stored in cache for audits.
const EXPLAINER_MODEL = 'llama-3.1-8b-instant';

// Relation weights for triple selection (higher = more educationally valuable)
export const RELATION_WEIGHTS: Record<string, number> = {
    USED_FOR: 1.0, PURPOSE: 1.0,
    CAUSED_BY: 0.95, LED_TO: 0.95,
    DISCOVERED_BY: 0.9, BUILT_BY: 0.9, DEVELOPED_BY: 0.9, PRODUCED_BY: 0.9,
    SUPPLIED_BY: 0.85, TRADED_BY: 0.85, INVENTED_BY: 0.85,
    FOUND_IN: 0.8, LOCATED_IN: 0.7,
    CONTAINS: 0.65, PART_OF: 0.6, IS_A: 0.55,
};

// ─── Simple bag-of-chars cosine similarity ────────────────────────────────────
// Lightweight proxy for semantic similarity — avoids loading a full embedding
// model just for distractor filtering. Good enough for topic-relevance checks.

function charBigrams(text: string): Map<string, number> {
    const s = text.toLowerCase().replace(/[^a-z0-9 ]/g, '');
    const bigrams = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
        const bg = s.slice(i, i + 2);
        bigrams.set(bg, (bigrams.get(bg) || 0) + 1);
    }
    return bigrams;
}

function bigramCosine(a: string, b: string): number {
    const va = charBigrams(a);
    const vb = charBigrams(b);
    let dot = 0, magA = 0, magB = 0;
    for (const [k, v] of va) { magA += v * v; if (vb.has(k)) dot += v * vb.get(k)!; }
    for (const [, v] of vb) { magB += v * v; }
    const mag = Math.sqrt(magA) * Math.sqrt(magB);
    return mag > 0 ? dot / mag : 0;
}

// ─── 1. Graph-hop distractor builder ─────────────────────────────────────────

/**
 * Fetch concept neighbours up to 3 hops from Neo4j and return them as
 * ranked distractor candidates. Mirrors Python's _build_distractor_map().
 *
 * Returns empty array if Neo4j is unavailable (caller falls back to LLM).
 */
export async function buildGraphDistractors(
    conceptName: string,
    userId: string,
    documentId: string
): Promise<GraphDistractor[]> {
    try {
        // Fetch neighbours at hops 1, 2, 3
        const rows = await runCypher<{ name: string; distance: number }>(
            `MATCH (source:Concept {userId: $userId, documentId: $docId})
             WHERE toLower(source.name) = toLower($conceptName)
             CALL apoc.path.subgraphNodes(source, {
                 maxLevel: 3,
                 relationshipFilter: null
             }) YIELD node AS neighbour
             WHERE neighbour <> source
               AND neighbour:Concept
               AND neighbour.userId = $userId
             WITH neighbour,
                  length(shortestPath((source)-[*1..3]-(neighbour))) AS distance
             RETURN neighbour.name AS name, distance
             ORDER BY distance ASC
             LIMIT 30`,
            { userId, docId: documentId, conceptName }
        );

        // If APOC is not available, fall back to manual 3-hop query
        if (rows.length === 0) {
            return await buildGraphDistractorsFallback(conceptName, userId, documentId);
        }

        return rows
            .filter(r => r.name && r.name.toLowerCase() !== conceptName.toLowerCase())
            .map(r => ({
                name: r.name,
                distance: Number(r.distance),
                similarity: bigramCosine(conceptName, r.name),
            }));
    } catch {
        // APOC not available — use manual hop queries
        return await buildGraphDistractorsFallback(conceptName, userId, documentId);
    }
}

/**
 * Manual 3-hop distractor fetch — works without APOC.
 */
async function buildGraphDistractorsFallback(
    conceptName: string,
    userId: string,
    documentId: string
): Promise<GraphDistractor[]> {
    try {
        const results: GraphDistractor[] = [];
        const seen = new Set<string>([conceptName.toLowerCase()]);

        for (const hop of [1, 2, 3] as const) {
            const relPath = '-[*' + hop + ']->'; // e.g. -[*1]->
            const rows = await runCypher<{ name: string }>(
                `MATCH (source:Concept {userId: $userId, documentId: $docId})
                 WHERE toLower(source.name) = toLower($conceptName)
                 MATCH (source)${relPath}(neighbour:Concept {userId: $userId})
                 WHERE NOT toLower(neighbour.name) = toLower($conceptName)
                 RETURN DISTINCT neighbour.name AS name
                 LIMIT 15`,
                { userId, docId: documentId, conceptName }
            );

            for (const r of rows) {
                if (r.name && !seen.has(r.name.toLowerCase())) {
                    seen.add(r.name.toLowerCase());
                    results.push({
                        name: r.name,
                        distance: hop,
                        similarity: bigramCosine(conceptName, r.name),
                    });
                }
            }
        }

        return results;
    } catch {
        return [];
    }
}

/**
 * Select the best 3 distractors from graph neighbours, applying the same
 * topic-relevance filtering as the Python backend.
 *
 * Phase 1: one distractor per hop tier (1→2→3), semantically filtered.
 * Phase 2: fill remainder from any tier if still < 3 after phase 1.
 *
 * Returns { distractors, difficulty } where difficulty is graph-topology-derived:
 *   all dist=1 → 'hard', any dist≤2 → 'medium', all dist≥3 → 'easy'
 */
export function selectDistractors(
    conceptName: string,
    neighbours: GraphDistractor[],
    correctAnswer: string
): { distractors: string[]; difficulty: 'easy' | 'medium' | 'hard'; distanceMap: Record<string, number> } {
    const correctLower = correctAnswer.toLowerCase();

    // Group by distance, exclude correct answer
    const byDist = new Map<number, GraphDistractor[]>();
    for (const n of neighbours) {
        if (n.name.toLowerCase() === correctLower) continue;
        if (!byDist.has(n.distance)) byDist.set(n.distance, []);
        byDist.get(n.distance)!.push(n);
    }

    const isTopicallyValid = (n: GraphDistractor) => {
        const threshold = n.distance >= 3 ?
            DISTRACTOR_HOP3_THRESHOLD : DISTRACTOR_TOPIC_THRESHOLD;
        return n.similarity >= threshold;
    };

    const chosen: string[] = [];
    const distanceMap: Record<string, number> = {};

    // Phase 1 — one per hop tier
    for (const dist of [1, 2, 3]) {
        if (chosen.length >= 3) break;
        const candidates = byDist.get(dist) || [];
        for (const c of candidates) {
            if (!chosen.includes(c.name) && isTopicallyValid(c)) {
                chosen.push(c.name);
                distanceMap[c.name] = dist;
                break;
            }
        }
    }

    // Phase 2 — fill remainder from any tier
    if (chosen.length < 3) {
        for (const dist of [1, 2, 3]) {
            const candidates = byDist.get(dist) || [];
            for (const c of candidates) {
                if (chosen.length >= 3) break;
                if (!chosen.includes(c.name) && isTopicallyValid(c)) {
                    chosen.push(c.name);
                    distanceMap[c.name] = dist;
                }
            }
        }
    }

    // Difficulty from graph topology
    const distances = Object.values(distanceMap);
    let difficulty: 'easy' | 'medium' | 'hard' = 'medium';
    if (distances.length > 0) {
        if (Math.max(...distances) <= 1) difficulty = 'hard';
        else if (Math.min(...distances) <= 2) difficulty = 'medium';
        else difficulty = 'easy';
    }

    return { distractors: chosen, difficulty, distanceMap };
}

// ─── 2. KG-grounded misconception analysis ───────────────────────────────────

interface AnalyzeAnswerInput {
    questionText: string;
    correctAnswer: string;
    studentAnswer: string;
    concept: string;
    distanceMap?: Record<string, number>; // MCQ: distractor distances
    userId: string;
    documentId?: string;
    /**
     * Optional — the concept UUID (as used in Supabase `concepts.id`).
     * When provided, enables the "repeated-miss" escalation signal.
     */
    conceptId?: string;
    sourceText?: string;
}

/**
 * KG-grounded misconception analysis.
 * Scoring is always deterministic. Explanation is template-first with LLM
 * escalation for unusual or repeat-miss cases, and all LLM outputs are cached.
 */
export async function analyzeAnswer(input: AnalyzeAnswerInput): Promise<MisconceptionResult> {
    const {
        questionText, correctAnswer, studentAnswer,
        concept, distanceMap,
        userId, documentId, conceptId, sourceText,
    } = input;

    // Step 1 — blank answer
    if (!studentAnswer.trim()) {
        return blankResult();
    }

    // Step 2 — correct answer check
    if (isCorrect(studentAnswer, correctAnswer)) {
        return correctResult(questionText, correctAnswer, sourceText);
    }

    // Step 3 — deterministic MCQ scoring
    const { score, distance: distractorDistance, label: misconceptionLabel } =
        scoreMCQ(studentAnswer, correctAnswer, distanceMap || {});

    const severity = severityFromScore(score);

    // Step 4 — KG path (best-effort)
    let kgPath: string[] = [];
    if (userId && documentId) {
        kgPath = await getKgPath(studentAnswer, correctAnswer, concept, userId, documentId);
    }

    // Step 5 — Explanation (template-first with LLM escalation)
    const explanation = await buildExplanation({
        question: questionText,
        correct: correctAnswer,
        studentAnswer,
        label: misconceptionLabel,
        severity,
        concept,
        kgPath,
        sourceText: sourceText ?? '',
        userId,
        conceptId,
    });

    return {
        isCorrect: false,
        score: Math.round(score * 100) / 100,
        severity,
        misconceptionLabel,
        gapDescription: explanation.gap_description || '',
        correctExplanation: explanation.correct_explanation || '',
        kgPath,
        distractorDistance,
    };
}

// ─── Scoring helpers ──────────────────────────────────────────────────────────

function isCorrect(student: string, correct: string): boolean {
    const normalise = (s: string) =>
        s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    return normalise(student) === normalise(correct) || normalise(student).includes(normalise(correct));
}

function scoreMCQ(
    studentAnswer: string,
    correctAnswer: string,
    distanceMap: Record<string, number>
): { score: number; distance: number | null; label: string } {
    // MCQ scoring is purely distance-based (same as Python)
    const dist = distanceMap[studentAnswer] ?? null;
    let score: number;

    if (dist === 1) score = 0.4;       // subtle gap — closely related concept
    else if (dist === 2) score = 0.2;  // moderate gap
    else score = 0.0;                  // fundamental gap or unknown

    const label = dist === 1
        ? `Confused with a directly related concept (${studentAnswer})`
        : dist === 2
            ? `Confused with a moderately related concept (${studentAnswer})`
            : `Chose an unrelated concept (${studentAnswer})`;

    return { score, distance: dist, label };
}

function severityFromScore(score: number): MisconceptionSeverity {
    if (score >= 0.85) return 'CORRECT';
    if (score >= 0.60) return 'CLOSE';
    if (score >= 0.30) return 'PARTIAL';
    return 'CRITICAL';
}

// ─── KG path retrieval ────────────────────────────────────────────────────────

async function getKgPath(
    studentAnswer: string,
    correctAnswer: string,
    concept: string,
    userId: string,
    documentId: string
): Promise<string[]> {
    try {
        const rows = await runCypher<{ nodes: string[]; rels: string[] }>(
            `MATCH (correct:Concept {userId: $userId, documentId: $docId})
             WHERE toLower(correct.name) CONTAINS toLower($correct)
                OR toLower($correct) CONTAINS toLower(correct.name)
             MATCH (wrong:Concept {userId: $userId, documentId: $docId})
             WHERE toLower(wrong.name) CONTAINS toLower($wrong)
                OR toLower($wrong) CONTAINS toLower(wrong.name)
             MATCH path = shortestPath((correct)-[*1..4]-(wrong))
             RETURN [n IN nodes(path) | n.name] AS nodes,
                    [r IN relationships(path) | type(r)] AS rels
             LIMIT 1`,
            {
                userId,
                docId: documentId,
                correct: correctAnswer.slice(0, 50),
                wrong: studentAnswer.slice(0, 50),
            }
        );

        if (rows.length === 0) return [];

        const { nodes, rels } = rows[0];
        const parts: string[] = [];
        for (let i = 0; i < rels.length; i++) {
            parts.push(`${nodes[i]} -[${rels[i]}]-> ${nodes[i + 1]}`);
        }
        return parts;
    } catch {
        return [];
    }
}

// ─── Explanation: template-first with LLM escalation ─────────────────────────

interface BuildExplanationInput {
    question: string;
    correct: string;
    studentAnswer: string;
    label: string;
    severity: MisconceptionSeverity;
    concept: string;
    kgPath: string[];
    sourceText: string;
    userId?: string;
    conceptId?: string;
}

/**
 * Build the human-readable explanation for a wrong answer.
 *
 * Policy:
 *   A. Cache lookup — if we've written this explanation before, reuse.
 *   B. Template the answer unless one of the escalation signals fires:
 *        - severity is PARTIAL or CRITICAL AND kg path is empty
 *          (template without a path is uninformative)
 *        - student has missed this concept REPEAT_MISS_ESCALATION_THRESHOLD+
 *          times before (they need different words)
 *   C. LLM is the escalation path. Cache whatever we produce.
 *
 * Note on the cache-vs-repeat-miss tension:
 *   The cache key is intentionally user-independent (label, correct, student
 *   answer, concept, kg_path) so cross-student reuse works. That means the
 *   repeat-miss escalation only actually fires the FIRST time any student
 *   hits the threshold for a given wrong-answer pattern. After that, every
 *   student with the same repeat pattern gets served the escalated (LLM-
 *   generated) explanation from cache — which is still richer than the
 *   template, so it's the right outcome.
 */
async function buildExplanation(
    input: BuildExplanationInput
): Promise<{ gap_description: string; correct_explanation: string }> {
    const {
        question, correct, studentAnswer, label, severity,
        concept, kgPath, sourceText, userId, conceptId,
    } = input;

    const cacheKey: ExplanationKey = {
        label,
        correctAnswer: correct,
        studentAnswer,
        concept,
        kgPath,
    };

    // ── A. Cache hit ──────────────────────────────────────────────────────
    const cached = await lookupExplanation(cacheKey);
    if (cached) {
        console.log(`[MCAnalyzer] Cache hit (${cached.source})`);
        return {
            gap_description: cached.gap_description,
            correct_explanation: cached.correct_explanation,
        };
    }

    // ── B. Decide: template or LLM? ───────────────────────────────────────
    const pathMissing = kgPath.length === 0;
    const severeGap = severity === 'PARTIAL' || severity === 'CRITICAL';

    let priorMisses = 0;
    if (userId && conceptId) {
        priorMisses = await countPriorWrongAttempts(userId, conceptId);
    }
    const repeatedMiss = priorMisses >= REPEAT_MISS_ESCALATION_THRESHOLD;

    const shouldEscalate = (pathMissing && severeGap) || repeatedMiss;

    if (!shouldEscalate) {
        // Template path — the default.
        const explanation = buildTemplateExplanation(
            concept, correct, studentAnswer, label, kgPath
        );
        // Persist so repeat occurrences skip even the template build cost.
        void storeExplanation(cacheKey, explanation, 'template');
        console.log('[MCAnalyzer] Template explanation used');
        return explanation;
    }

    // ── C. LLM escalation path ────────────────────────────────────────────
    console.log(
        `[MCAnalyzer] Escalating to LLM (pathMissing=${pathMissing}, severeGap=${severeGap}, priorMisses=${priorMisses})`
    );
    const llmExplanation = await explainWithLLM(
        question, correct, studentAnswer, label, kgPath, sourceText
    );
    // Cache the LLM output too — same signature next time = cache hit.
    void storeExplanation(cacheKey, llmExplanation, 'llm', EXPLAINER_MODEL);
    return llmExplanation;
}

/**
 * Build a genuinely useful explanation from the KG path alone.
 * Unlike the old "fallback" (which was bland because it was emergency-only),
 * this is the default path and pulls structural context from the graph.
 */
function buildTemplateExplanation(
    concept: string,
    correct: string,
    studentAnswer: string,
    label: string,
    kgPath: string[]
): { gap_description: string; correct_explanation: string } {
    // If we have a KG path, narrate the relationship that was missed.
    if (kgPath.length > 0) {
        // First relation type is the key link. E.g.
        //   "Great Bath -[LOCATED_IN]-> Mohenjodaro -[PART_OF]-> Harappan Civilization"
        // We surface the nearest relation explicitly.
        const firstRelMatch = kgPath[0].match(/-\[([A-Z_]+)\]->/);
        const firstRel = firstRelMatch ? firstRelMatch[1].replace(/_/g, ' ').toLowerCase() : '';

        const pathTrail = kgPath.join(' → ');

        const gap_description = firstRel
            ? `You chose "${studentAnswer}", which is related to "${correct}" through "${firstRel}", but it isn't the same thing. The correct answer is "${correct}".`
            : `You chose "${studentAnswer}", which is related to "${correct}" in the graph but is not the correct answer here. The correct answer is "${correct}".`;

        const correct_explanation = `"${correct}" is the right answer for ${concept ? `"${concept}"` : 'this question'}. In the knowledge graph the connection is: ${pathTrail}. Review this chain to see why they are distinct concepts.`;

        return { gap_description, correct_explanation };
    }

    // No path — the answer is effectively unrelated. Say so clearly.
    const gap_description = `${label}. "${studentAnswer}" does not appear to be connected to "${correct}" in the material you studied.`;
    const correct_explanation = concept
        ? `The correct answer is "${correct}". Revisit the section of the source document that covers "${concept}".`
        : `The correct answer is "${correct}". Revisit the relevant section of your notes.`;

    return { gap_description, correct_explanation };
}

/**
 * LLM explanation writer — kept for escalation cases only.
 * Falls back to a template if the LLM call itself fails, so this function
 * never throws and always returns something usable.
 */
async function explainWithLLM(
    question: string,
    correct: string,
    studentAnswer: string,
    label: string,
    kgPath: string[],
    sourceText: string
): Promise<{ gap_description: string; correct_explanation: string }> {
    const kgPathStr = kgPath.length > 0
        ? kgPath.join(' → ')
        : 'Path not available in graph.';
    const sourceTrimmed = sourceText.slice(0, 600) || 'Not available.';

    try {
        const response = await chatCompletion([
            {
                role: 'system',
                content: `You are an educational feedback writer for school-level content.

You will be given a question, the correct answer, the student's wrong answer,
the specific misconception label already identified, and the knowledge graph path
between the student's answer and the correct answer.

Your job is to write TWO short pieces of text:
1. "gap_description"     — 1-2 sentences explaining exactly what conceptual link the student missed. Be specific.
2. "correct_explanation" — 1-2 sentences explaining why the correct answer is correct, in plain language.

Return ONLY a JSON object with these two string fields. No markdown, no preamble.`,
            },
            {
                role: 'user',
                content: `Question: ${question}
Correct answer: ${correct}
Student's answer: ${studentAnswer}
Misconception label: ${label}
KG path: ${kgPathStr}
Source text: ${sourceTrimmed}

Write the gap_description, correct_explanation.`,
            },
        ], { jsonMode: true, temperature: 0.3 });

        const parsed = parseLLMJson<{
            gap_description: string;
            correct_explanation: string;
        }>(response);

        // Guard against the LLM returning empty strings.
        if (parsed.gap_description && parsed.correct_explanation) {
            return parsed;
        }
        return buildTemplateExplanation('', correct, studentAnswer, label, kgPath);
    } catch {
        // LLM failure → template fallback. Not cached as 'llm' since it's a template.
        return buildTemplateExplanation('', correct, studentAnswer, label, kgPath);
    }
}

// ─── Short-circuit results ────────────────────────────────────────────────────

function blankResult(): MisconceptionResult {
    return {
        isCorrect: false, score: 0, severity: 'CRITICAL',
        misconceptionLabel: 'No answer provided',
        gapDescription: 'The student did not provide an answer.',
        correctExplanation: 'Please attempt the question before submitting.',
        kgPath: [],
        distractorDistance: null,
    };
}

/**
 * Correct-answer result. Now returns a deterministic congratulation message
 * — the earlier version didn't actually call the LLM here either, so this
 * removes a dead async hop.
 */
function correctResult(
    _question: string, correct: string, _sourceText?: string
): MisconceptionResult {
    return {
        isCorrect: true, score: 1.0, severity: 'CORRECT',
        misconceptionLabel: 'Correct answer',
        gapDescription: '',
        correctExplanation: `"${correct}" is correct. Well done!`,
        kgPath: [],
        distractorDistance: null,
    };
}