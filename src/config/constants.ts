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
// Maps question type → Bloom's level (1=Remember, 2=Understand, 3=Apply, 4=Analyze)
export const COGNITIVE_LEVEL_MAP: Record<string, number> = {
    recall: 1,
    conceptual: 2,
    application: 3,
    reasoning: 3,
    analytical: 4,
};

// ─── Relation Bloom's Map ───
// Maps KG relation type → Bloom's cognitive level
// Used by question generator to select appropriate question template
export const RELATION_BLOOM_MAP: Record<string, number> = {
    IS_A: 1, // Remember — classify
    DEFINES: 1, // Remember — recall definition
    EXAMPLE_OF: 1, // Remember — identify example
    PART_OF: 2, // Understand — describe structure
    FEATURE_OF: 2, // Understand — describe properties
    CAUSES: 2, // Understand — explain cause-effect
    CONTRASTS_WITH: 3, // Apply — compare and distinguish
    USED_FOR: 3, // Apply — use in context
    PRECEDES: 2, // Understand — sequence events
    REQUIRES: 3, // Apply — identify dependencies
    EXTENSION_OF: 4, // Analyze — relate advanced to foundational
};

// ─── Question Count Limits Per Mode ───
export const QUESTION_LIMITS: Record<string, { min: number; max: number }> = {
    diagnostic: { min: 5, max: 10 },
    practice: { min: 5, max: 15 },
    mastery: { min: 8, max: 15 },
    spaced: { min: 5, max: 8 },
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

// ─── MSS Weights ───
// Weights applied to wrong attempts based on confidence level
// High confidence + wrong = strong misconception signal (weight 2.0)
// Medium confidence + wrong = mild misconception signal (weight 1.5)
// Low confidence + wrong = likely unknown, not misconceived (weight 1.0)
export const MSS_WEIGHTS = {
    high_confidence_wrong: 2.0,   // confidence > 0.7
    medium_confidence_wrong: 1.5, // confidence 0.4–0.7
    low_confidence_wrong: 1.0,    // confidence < 0.4
};

// ─── MSS Cap for Summary Completion ───
// If MSS exceeds this threshold when student passes summary,
// mastery is capped at MSS_MASTERY_CAP instead of allowing full score
export const MSS_THRESHOLD = 0.5;
export const MSS_MASTERY_CAP = 0.85;

// ─── Learn It Priority Weights ───
export const LEARN_IT_WEIGHTS = {
    ccms_deficit: 0.5, // (1 - CCMS) component
    mss: 0.5,          // MSS component
};

// ─── DAG Validation ───
// Minimum confidence for a REQUIRES edge to act as a hard DAG gate
// Edges below this are kept as soft links but do not block progression
export const DAG_EDGE_CONFIDENCE_THRESHOLD = 0.65;

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

// ─── Verification Pass ───
// Minimum confidence for a triple to pass the LLM verification pass
// Triples below this threshold are discarded as potential hallucinations
export const VERIFICATION_CONFIDENCE_THRESHOLD = 0.80;

// ─── Spaced Repetition ───
// Retrievability threshold below which a spaced review is triggered
// R(t) = (1 + t / (9 × S))^(-1) — when R drops below this, review is due
export const FSRS_REVIEW_THRESHOLD = 0.9;

// ─── Forgetting Model ───
// Default hours elapsed used when no prior mastery record exists
// for spaced mode scoring
export const DEFAULT_HOURS_ELAPSED = 24;