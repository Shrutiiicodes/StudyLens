// ─── Application Constants ───

export const APP_NAME = 'Study Lens';
export const APP_DESCRIPTION = 'AI-Powered Foundational Concept Mastery Platform for CBSE Grade 4–10';

// ─── Upload Limits ───
export const MIN_WORD_COUNT = 500;
export const MAX_FILE_SIZE_MB = 10;
export const ALLOWED_FILE_TYPES = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];

// ─── Chunking ───
export const CHUNK_MIN_TOKENS = 500;
export const CHUNK_MAX_TOKENS = 800;
export const CHUNK_OVERLAP_TOKENS = 50;

// ─── Personalization ───
export const GAMMA_FORGETTING = 0.05;

export const MASTERY_UNLOCK_THRESHOLD = 85;
export const MASTERY_LOCK_THRESHOLD = 70;

// ─── Pass Threshold ───
// Mastery learning standard: 80% per Bloom (1984).
// Bloom, B.S. (1984). The 2 sigma problem.
// Educational Researcher, 13(6), 4–16.
export const PASS_THRESHOLD = 80;

// ─── Diagnostic ───
export const DIAGNOSTIC_QUESTION_COUNT = 5;

// ─── Question Types ───
export const QUESTION_TYPES = ['recall', 'conceptual', 'application', 'reasoning', 'analytical'] as const;
export const DIFFICULTY_LEVELS = [1, 2, 3] as const;

// ─── Cognitive Levels ───
export const COGNITIVE_LEVEL_MAP: Record<string, number> = {
    recall: 1,
    conceptual: 2,
    application: 3,
    reasoning: 3,
    analytical: 4,
};

// ─── Question Count Limits Per Mode ───
export const QUESTION_LIMITS: Record<string, { min: number; max: number }> = {
    diagnostic: { min: 3, max: 5 },
    practice: { min: 3, max: 7 },
    mastery: { min: 5, max: 8 },
};

export const SPACED_WEIGHTS = {
    accuracy: 0.5,
    time_weight: 0.3,
    speed_efficiency: 0.2,
};

// ─── SAI Weights ───
export const SAI_WEIGHTS = {
    mastery: 0.5,
    trend: 0.2,
    global_accuracy: 0.2,
    calibration: 0.1,
};

// ─── MSS Weights ───
export const MSS_WEIGHTS = {
    high_confidence_wrong: 2.0,
    medium_confidence_wrong: 1.5,
    low_confidence_wrong: 1.0,
};

// ─── Learn It Priority Weights ───
export const LEARN_IT_WEIGHTS = {
    ccms_deficit: 0.5,
    mss: 0.5,
};

// ─── DAG Validation ───
export const DAG_EDGE_CONFIDENCE_THRESHOLD = 0.65;

// ─── Grade Levels ───
export const GRADE_LEVELS = Array.from({ length: 7 }, (_, i) => i + 4);

// ─── LLM Config ───
export const GROQ_MODEL = 'qwen/qwen3-32b';
export const GROQ_TEMPERATURE = 0.3;
export const GROQ_MAX_TOKENS = 4096;

// ─── Expected Time Per Question (seconds) ───
export const EXPECTED_TIME: Record<number, number> = {
    1: 30,
    2: 60,
    3: 90,
};

// ─── Verification Pass ───
export const VERIFICATION_CONFIDENCE_THRESHOLD = 0.80;

// ─── Spaced Repetition ───
export const FSRS_REVIEW_THRESHOLD = 0.9;

// ─── Forgetting Model ───
export const DEFAULT_HOURS_ELAPSED = 24;

// ─── Backend URL ───
export const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000';

// ─── Stages ───
// Ordered progression stages a student moves through for each concept.
// 'complete' is a terminal *status*, not an actionable stage — kept separate.
export const STAGE_KEYS = ['diagnostic', 'practice', 'mastery'] as const;
export type StageKey = (typeof STAGE_KEYS)[number];

// Full set including terminal status — used where 'complete' must be indexed.
export const STAGE_KEYS_WITH_COMPLETE = [...STAGE_KEYS, 'complete'] as const;
export type StageKeyWithComplete = (typeof STAGE_KEYS_WITH_COMPLETE)[number];

// Rich UI metadata for each stage (icons are added at the call-site in TSX).
export const STAGE_DEFS: Array<{ key: StageKey; label: string; description: string }> = [
    { key: 'diagnostic', label: 'Easy 5',        description: 'Initial knowledge check' },
    { key: 'practice',   label: 'Practice Test',  description: 'Adaptive practice questions' },
    { key: 'mastery',    label: 'Mastery Test',   description: 'Prove full understanding' },
];