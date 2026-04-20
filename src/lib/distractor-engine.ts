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
 *  - The LLM's only job is writing human-readable explanations.
 *  - Everything degrades gracefully if Neo4j is unavailable.
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
    checks: {                        // short-answer only
        object: boolean;
        relation: boolean;
        subject: boolean;
    };
    distractorDistance: number | null; // MCQ only
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Minimum cosine similarity for a distractor to be topically relevant
const DISTRACTOR_TOPIC_THRESHOLD = 0.12;    // hops 1 & 2
const DISTRACTOR_HOP3_THRESHOLD = 0.18;    // hop 3 — tighter

// Relation weights for triple selection (higher = more educationally valuable)
export const RELATION_WEIGHTS: Record<string, number> = {
    USED_FOR: 1.0, PURPOSE: 1.0,
    CAUSED_BY: 0.95, LED_TO: 0.95,
    DISCOVERED_BY: 0.9, BUILT_BY: 0.9, DEVELOPED_BY: 0.9, PRODUCED_BY: 0.9,
    SUPPLIED_BY: 0.85, TRADED_BY: 0.85, INVENTED_BY: 0.85,
    FOUND_IN: 0.8, LOCATED_IN: 0.7,
    CONTAINS: 0.65, PART_OF: 0.6, IS_A: 0.55,
};

// Relation keywords for short-answer relation check
const RELATION_KEYWORDS: Record<string, string[]> = {
    LOCATED_IN: ['located', 'found', 'in', 'at', 'city', 'place', 'site'],
    FOUND_IN: ['found', 'discovered', 'located', 'in', 'at'],
    USED_FOR: ['used', 'purpose', 'function', 'for', 'served'],
    SUPPLIED_BY: ['supplied', 'provided', 'sent', 'came from', 'source'],
    PART_OF: ['part of', 'belongs to', 'component', 'section', 'member'],
    BUILT_BY: ['built', 'constructed', 'made', 'created', 'erected'],
    DISCOVERED_BY: ['discovered', 'found', 'excavated', 'unearthed'],
    PRODUCED_BY: ['produced', 'made', 'created', 'manufactured'],
    TRADED_BY: ['traded', 'exchanged', 'sold', 'bought', 'commerce'],
    CAUSED_BY: ['caused', 'led to', 'resulted from', 'because', 'due to'],
    LED_TO: ['led to', 'caused', 'resulted in', 'brought about'],
    REQUIRES: ['requires', 'needs', 'depends on', 'prerequisite'],
    CAUSES: ['causes', 'leads to', 'results in', 'produces'],
    IS_A: ['is a', 'type of', 'kind of', 'example of', 'subclass'],
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
        const threshold = n.distance >= 3 ? DISTRACTOR_HOP3_THRESHOLD : DISTRACTOR_TOPIC_THRESHOLD;
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
    qType: 'mcq' | 'short';
    concept: string;
    relation: string;
    distanceMap?: Record<string, number>; // MCQ: distractor distances
    userId: string;
    documentId?: string;
    sourceText?: string;
}

/**
 * KG-grounded misconception analysis.
 * Primary: uses graph structure for deterministic scoring.
 * Fallback: LLM-only scoring if Neo4j is unavailable.
 */
export async function analyzeAnswer(input: AnalyzeAnswerInput): Promise<MisconceptionResult> {
    const {
        questionText, correctAnswer, studentAnswer,
        qType, concept, relation, distanceMap,
        userId, documentId, sourceText,
    } = input;

    // Step 1 — blank answer
    if (!studentAnswer.trim()) {
        return blankResult();
    }

    // Step 2 — correct answer check
    if (isCorrect(studentAnswer, correctAnswer)) {
        return correctResult(questionText, correctAnswer, sourceText);
    }

    // Step 3 — deterministic scoring
    let score: number;
    let checks = { object: false, relation: false, subject: false };
    let misconceptionLabel: string;
    let distractorDistance: number | null = null;

    if (qType === 'mcq') {
        const result = scoreMCQ(studentAnswer, correctAnswer, distanceMap || {});
        score = result.score;
        distractorDistance = result.distance;
        misconceptionLabel = result.label;
    } else {
        const result = scoreShortAnswer(studentAnswer, correctAnswer, concept, relation);
        score = result.score;
        checks = result.checks;
        misconceptionLabel = result.label;
    }

    const severity = severityFromScore(score);

    // Step 4 — KG path (best-effort)
    let kgPath: string[] = [];
    if (userId && documentId) {
        kgPath = await getKgPath(studentAnswer, correctAnswer, concept, userId, documentId);
    }

    // Step 5 — LLM explanation
    const explanation = await explainMisconception(
        questionText, correctAnswer, studentAnswer,
        misconceptionLabel, kgPath, sourceText || ''
    );

    return {
        isCorrect: false,
        score: Math.round(score * 100) / 100,
        severity,
        misconceptionLabel,
        gapDescription: explanation.gap_description || '',
        correctExplanation: explanation.correct_explanation || '',
        kgPath,
        checks,
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

function scoreShortAnswer(
    studentAnswer: string,
    correctAnswer: string,
    concept: string,
    relation: string
): { score: number; checks: { object: boolean; relation: boolean; subject: boolean }; label: string } {
    const sLower = studentAnswer.toLowerCase();
    const cLower = correctAnswer.toLowerCase();
    const conLower = concept.toLowerCase();

    // Object check (weight 0.6)
    const correctWords = new Set(
        cLower.replace(/[^\w\s]/g, '').split(/\s+/)
            .filter(w => !['the', 'a', 'an', 'and', 'of'].includes(w))
    );
    const studentWords = new Set(sLower.replace(/[^\w\s]/g, '').split(/\s+/));
    const overlap = correctWords.size > 0
        ? [...correctWords].filter(w => studentWords.has(w)).length / correctWords.size
        : 0;
    const objScore = Math.min(overlap, 1.0);
    const objectOk = objScore >= 0.5;

    // Relation check (weight 0.25)
    const relKeywords = RELATION_KEYWORDS[relation.toUpperCase()] || [];
    const relationOk = relKeywords.length > 0
        ? relKeywords.some(kw => sLower.includes(kw))
        : true;

    // Subject check (weight 0.15)
    const conceptWords = new Set(
        conLower.replace(/[^\w\s]/g, '').split(/\s+/)
            .filter(w => !['the', 'a', 'an'].includes(w))
    );
    const subjectOk = conceptWords.size > 0
        ? [...conceptWords].some(w => sLower.includes(w))
        : true;

    const score = objScore * 0.6 + (relationOk ? 1.0 : 0.0) * 0.25 + (subjectOk ? 1.0 : 0.0) * 0.15;
    const checks = { object: objectOk, relation: relationOk, subject: subjectOk };

    const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
    const relReadable = relation.toLowerCase().replace(/_/g, ' ');
    let label: string;

    if (failed.length === 0) label = 'Minor wording issue — answer is essentially correct';
    else if (JSON.stringify(failed) === JSON.stringify(['object'])) label = `Wrong answer for ${concept} — did not identify the correct ${relReadable}`;
    else if (JSON.stringify(failed) === JSON.stringify(['relation'])) label = `Correct topic but wrong relationship type — expected ${relReadable}`;
    else if (failed.includes('object') && failed.includes('relation')) label = `Fundamental gap on ${concept} — wrong answer and wrong relationship`;
    else label = `Incomplete answer on ${concept} — missing: ${failed.join(', ')}`;

    return { score: Math.round(score * 100) / 100, checks, label };
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

// ─── LLM explanation writer ───────────────────────────────────────────────────

async function explainMisconception(
    question: string,
    correct: string,
    studentAnswer: string,
    label: string,
    kgPath: string[],
    sourceText: string
): Promise<{ gap_description: string; correct_explanation: string; }> {
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

Your job is to write THREE short pieces of text:
1. "gap_description"     — 1-2 sentences explaining exactly what conceptual link the student missed. Be specific.
2. "correct_explanation" — 1-2 sentences explaining why the correct answer is correct, in plain language.

Return ONLY a JSON object with these three string fields. No markdown, no preamble.`,
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

        return parseLLMJson<{ gap_description: string; correct_explanation: string; }>(response);
    } catch {
        // Template fallback if LLM fails
        return {
            gap_description: `The student answered "${studentAnswer}" but the correct answer is "${correct}". ${label}.`,
            correct_explanation: `The correct answer is "${correct}". Review the relevant section of your notes.`,
        };
    }
}

// ─── Short-circuit results ────────────────────────────────────────────────────

function blankResult(): MisconceptionResult {
    return {
        isCorrect: false, score: 0, severity: 'CRITICAL',
        misconceptionLabel: 'No answer provided',
        gapDescription: 'The student did not provide an answer.',
        correctExplanation: 'Please attempt the question before submitting.',
        kgPath: [], checks: { object: false, relation: false, subject: false },
        distractorDistance: null,
    };
}

async function correctResult(
    question: string, correct: string, sourceText?: string
): Promise<MisconceptionResult> {
    return {
        isCorrect: true, score: 1.0, severity: 'CORRECT',
        misconceptionLabel: 'Correct answer',
        gapDescription: '',
        correctExplanation: `"${correct}" is correct. Well done!`,
        kgPath: [], checks: { object: true, relation: true, subject: true },
        distractorDistance: null,
    };
}