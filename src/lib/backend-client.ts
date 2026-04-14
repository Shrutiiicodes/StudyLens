/**
 * Backend Client
 * 
 * Typed HTTP client for calling the Python FastAPI backend.
 * All calls are wrapped in try/catch and are non-fatal —
 * if the backend is down, Study-Lens continues to work 
 * with its own KG builder and question generator.
 */

const getBackendUrl = () =>
    process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000';

// ─── Types ───────────────────────────────────────────────────────────────

export interface IngestResult {
    doc_id: string;
    storage_path: string;
    page_count: number;
    chunk_count: number;
    triple_count: number;
    question_count: number;
    message: string;
}

export interface MisconceptionItem {
    question_id: string;
    question: string;
    q_type: string;
    concept: string;
    relation: string;
    difficulty: string;
    correct_answer: string;
    student_answer: string;
    is_correct: boolean;
    score: number;
    severity: 'CORRECT' | 'CLOSE' | 'PARTIAL' | 'CRITICAL';
    misconception_label: string;
    gap_description: string;
    correct_explanation: string;
    hint: string;
    kg_path: string[];
    checks: Record<string, boolean>;
    distractor_distance: number | null;
}

export interface MisconceptionReport {
    doc_id: string;
    total_questions: number;
    correct: number;
    incorrect: number;
    score_percent: number;
    avg_score: number;
    severity_counts: Record<string, number>;
    concept_mastery: Array<{
        concept: string;
        avg_score: number;
        attempts: number;
        mastered: boolean;
    }>;
    concepts_to_review: string[];
    breakdown: MisconceptionItem[];
}

export interface TripleScore {
    subject: string;
    relation: string;
    object: string;
    chunk_id: string;
    score: number;
    relation_weight: number;
    subject_centrality: number;
    object_centrality: number;
    source_support: number;
    answer_specificity: number;
    distinctness: number;
}

// ─── API Calls ───────────────────────────────────────────────────────────

/**
 * Trigger the backend OCR ingestion pipeline for a document.
 * Called after Study-Lens uploads to Supabase and builds its own KG.
 */
export async function ingestDocument(
    storagePath: string,
    userId: string,
    documentId: string
): Promise<IngestResult | null> {
    try {
        const res = await fetch(`${getBackendUrl()}/ingest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                storage_path: storagePath,
                user_id: userId,
                document_id: documentId,
            }),
        });

        if (!res.ok) {
            const errBody = await res.json().catch(() => ({}));
            console.warn('[Backend] Ingest failed:', res.status, errBody);
            return null;
        }

        return await res.json();
    } catch (err) {
        console.warn('[Backend] Ingest call failed (backend may be offline):', (err as Error).message);
        return null;
    }
}

/**
 * Submit answers to the backend for KG-grounded misconception analysis.
 * This enriches Study-Lens's standard evaluation with:
 *   - severity levels (CORRECT/CLOSE/PARTIAL/CRITICAL)
 *   - gap_description (what conceptual link was missed)
 *   - hint (Socratic nudge)
 *   - kg_path (graph evidence for the misconception)
 */
export async function getMisconceptionReport(
    docId: string,
    userId: string,
    answers: Array<{
        question_id: string;
        student_answer: string;
        chosen_option?: string;
    }>
): Promise<MisconceptionReport | null> {
    try {
        const res = await fetch(`${getBackendUrl()}/submit-all`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                doc_id: docId,
                user_id: userId,
                answers,
            }),
        });

        if (!res.ok) {
            console.warn('[Backend] Submit-all failed:', res.status);
            return null;
        }

        return await res.json();
    } catch (err) {
        console.warn('[Backend] Submit-all call failed (non-fatal):', (err as Error).message);
        return null;
    }
}

/**
 * Get scored KG triples for a document, ranked by learning value.
 */
export async function getScoredTriples(
    docId: string,
    limit: number = 50
): Promise<{ triples: TripleScore[]; count: number } | null> {
    try {
        const res = await fetch(`${getBackendUrl()}/triples/${docId}?limit=${limit}`);
        if (!res.ok) return null;
        return await res.json();
    } catch (err) {
        console.warn('[Backend] Triples call failed (non-fatal):', (err as Error).message);
        return null;
    }
}

/**
 * Get backend questions generated from the KG triple approach.
 * These are a bonus pool of graph-grounded questions.
 */
export async function getBackendQuestions(
    docId: string,
    options: { difficulty?: string; type?: string; limit?: number } = {}
): Promise<{ questions: any[]; count: number } | null> {
    try {
        const params = new URLSearchParams();
        if (options.difficulty) params.set('difficulty', options.difficulty);
        if (options.type) params.set('type', options.type);
        if (options.limit) params.set('limit', String(options.limit));

        const url = `${getBackendUrl()}/questions/${docId}?${params.toString()}`;
        const res = await fetch(url);
        if (!res.ok) return null;
        return await res.json();
    } catch (err) {
        console.warn('[Backend] Questions call failed (non-fatal):', (err as Error).message);
        return null;
    }
}

/**
 * Get misconception summary for a document (teacher/admin view).
 */
export async function getMisconceptionSummary(
    docId: string
): Promise<any | null> {
    try {
        const res = await fetch(`${getBackendUrl()}/summary/${docId}`);
        if (!res.ok) return null;
        return await res.json();
    } catch (err) {
        console.warn('[Backend] Summary call failed (non-fatal):', (err as Error).message);
        return null;
    }
}

/**
 * Check if the backend is online and Neo4j is reachable.
 */
export async function checkBackendHealth(): Promise<boolean> {
    try {
        const res = await fetch(`${getBackendUrl()}/health`, {
            signal: AbortSignal.timeout(3000),
        });
        return res.ok;
    } catch {
        return false;
    }
}
