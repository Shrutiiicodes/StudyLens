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
export const LAMBDA_PRACTICE = 0.2;
export const LAMBDA_MASTERY = 0.35;
export const LAMBDA_SPACED = 0.5;
export const GAMMA_FORGETTING = 0.05;

export const MASTERY_UNLOCK_THRESHOLD = 85;
export const MASTERY_LOCK_THRESHOLD = 70;

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

// ─── Assessment Weights ───
export const DIAGNOSTIC_WEIGHTS = {
    accuracy: 0.5,
    cognitive_depth: 0.3,
    confidence_calibration: 0.2,
};

export const PRACTICE_WEIGHTS = {
    accuracy: 0.4,
    cognitive_depth: 0.2,
    speed_efficiency: 0.15,
    confidence_calibration: 0.15,
    misconception_penalty: 0.1,
};

export const MASTERY_WEIGHTS = {
    accuracy: 0.35,
    cognitive_depth: 0.30,
    misconception_penalty: 0.15,
    speed_efficiency: 0.10,
    confidence_calibration: 0.10,
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

// ─── Grade Levels ───
export const GRADE_LEVELS = Array.from({ length: 7 }, (_, i) => i + 4); // 4-10

// ─── LLM Config ───
export const GROQ_MODEL = 'llama-3.3-70b-versatile';
export const GROQ_TEMPERATURE = 0.3;
export const GROQ_MAX_TOKENS = 4096;

// ─── Expected Time Per Question (seconds) ───
export const EXPECTED_TIME: Record<number, number> = {
    1: 30,
    2: 60,
    3: 90,
};
