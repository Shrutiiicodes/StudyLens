import { AssessmentMode } from './student';

/**
 * Per-session breakdown of attempt counts by difficulty and question type.
 * Computed by /api/history from the attempts table, one per session.
 */
export interface SessionBreakdown {
    total: number;
    correct: number;
    by_difficulty: {
        easy: number;
        medium: number;
        hard: number;
    };
    by_difficulty_incorrect: {
        easy: number;
        medium: number;
        hard: number;
    };
    by_type: Record<string, { total: number; incorrect: number }>;
}

/**
 * One row in the history page's session list.
 * Returned by GET /api/history.
 */
export interface SessionRecord {
    id: string;
    concept_id: string;
    concept_title: string;
    mode: AssessmentMode | string;  // allow raw string for legacy rows
    score: number;
    passed: boolean;
    nlg: number | null;
    brier_score: number | null;
    created_at: string;
    breakdown: SessionBreakdown | null;
}

/**
 * A concept the student is struggling with, surfaced on the history page.
 * Aggregated by /api/history from incorrect attempts.
 */
export interface WeakTopic {
    concept_id: string;
    concept_title: string;
    incorrect_count: number;
    questions: Array<{
        question_text: string;
        correct_answer: string;
        difficulty: number;
    }>;
}

/**
 * Compact session shape used by the concept-detail page's history tab.
 * Subset of SessionRecord — no breakdown, no concept_title (it's already
 * the title of the page the user is viewing).
 */
export interface ConceptSessionSummary {
    id: string;
    mode: AssessmentMode | string;
    score: number;
    passed: boolean;
    nlg: number | null;
    created_at: string;
}