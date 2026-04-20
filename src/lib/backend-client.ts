/**
 * backend-client.ts
 * Typed HTTP client for all Study-Lens → IPD FastAPI backend calls.
 * Every function is non-fatal by default — the frontend still works
 * if the Python backend is down.
 */

const BACKEND_URL =
    process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000';

// ─── Types (mirror IPD dataclasses) ────────────────────────────────────────

export interface IngestResult {
    doc_id: string;
    status: string;
    page_count: number;
    chunk_count: number;
    triple_count: number;
    question_count: number;
    ocr_applied: boolean;
    quality_score: number;
    message?: string;
}

export interface MisconceptionItem {
    question_id: string;
    question: string;
    correct_answer: string;
    student_answer: string;
    chosen_option?: string;
    is_correct: boolean;
    score: number;
    severity: 'CORRECT' | 'CLOSE' | 'PARTIAL' | 'CRITICAL';
    misconception_label: string;
    gap_description: string;
    correct_explanation: string;
    kg_path: Array<{ from: string; relation: string; to: string }>;
    checks: Record<string, boolean>;
    distractor_distance?: number;
}

export interface MisconceptionReport {
    doc_id: string;
    user_id: string;
    total: number;
    correct_count: number;
    breakdown: MisconceptionItem[];
    severity_distribution: Record<string, number>;
    critical_gaps: string[];
}

export interface AnswerPayload {
    question_id: string;
    student_answer: string;
    chosen_option?: string;
}

export interface Triple {
    subject: string;
    predicate: string;
    object: string;
    weight?: number;
}

export interface TriplesResult {
    doc_id: string;
    triples: Triple[];
    count: number;
}

export interface HealthResult {
    status: string;
    neo4j: boolean;
    groq: boolean;
    version: string;
}

// ─── Core helper ────────────────────────────────────────────────────────────

async function backendFetch<T>(
    path: string,
    options: RequestInit = {},
    timeoutMs = 60_000
): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetch(`${BACKEND_URL}${path}`, {
            ...options,
            signal: controller.signal,
            headers: {
                'Content-Type': 'application/json',
                ...(options.headers || {}),
            },
        });

        if (!res.ok) {
            const text = await res.text().catch(() => res.statusText);
            throw new Error(`Backend ${path} → ${res.status}: ${text}`);
        }

        return res.json() as Promise<T>;
    } finally {
        clearTimeout(timer);
    }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * POST /ingest
 * Trigger the IPD OCR + chunking + KG + question generation pipeline.
 * Returns immediately with a doc_id; the pipeline runs async on the backend.
 */
export async function ingestDocument(
    storagePath: string,
    userId: string,
    documentId: string
): Promise<IngestResult> {
    return backendFetch<IngestResult>('/ingest', {
        method: 'POST',
        body: JSON.stringify({
            storage_path: storagePath,
            user_id: userId,
            document_id: documentId,
        }),
    });
}

/**
 * POST /submit-all
 * Submit all student answers at once and get a full misconception report.
 * Includes KG-grounded gap analysis, severity classification.
 */
export async function getMisconceptionReport(
    docId: string,
    userId: string,
    answers: AnswerPayload[]
): Promise<MisconceptionReport | null> {
    try {
        return await backendFetch<MisconceptionReport>('/submit-all', {
            method: 'POST',
            body: JSON.stringify({
                doc_id: docId,
                user_id: userId,
                answers,
            }),
        });
    } catch (err) {
        console.warn('[BackendClient] getMisconceptionReport failed (non-fatal):', err);
        return null;
    }
}

/**
 * GET /triples?doc_id=xxx
 * Fetch all verified triples for a document.
 */
export async function getTriples(docId: string): Promise<TriplesResult | null> {
    try {
        return await backendFetch<TriplesResult>(
            `/triples?doc_id=${encodeURIComponent(docId)}`
        );
    } catch (err) {
        console.warn('[BackendClient] getTriples failed (non-fatal):', err);
        return null;
    }
}

/**
 * GET /questions?doc_id=xxx&user_id=xxx
 * Fetch IPD-generated graph-grounded questions for a document.
 * These can optionally supplement Study-Lens's question pool.
 */
export async function getGraphQuestions(
    docId: string,
    userId: string
): Promise<{ questions: unknown[] } | null> {
    try {
        return await backendFetch(
            `/questions?doc_id=${encodeURIComponent(docId)}&user_id=${encodeURIComponent(userId)}`
        );
    } catch (err) {
        console.warn('[BackendClient] getGraphQuestions failed (non-fatal):', err);
        return null;
    }
}

/**
 * GET /health
 * Check if the backend + its dependencies are up.
 */
export async function healthCheck(): Promise<HealthResult | null> {
    try {
        return await backendFetch<HealthResult>('/health', {}, 5_000);
    } catch {
        return null;
    }
}