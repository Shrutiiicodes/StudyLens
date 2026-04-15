// ─── Application Constants ───

export const APP_NAME = 'Study Lens';
export const APP_DESCRIPTION = 'AI-Powered Foundational Concept Mastery Platform for CBSE Grade 4–10';

// ─── Upload Limits ───
export const MIN_WORD_COUNT = 500;
export const MAX_FILE_SIZE_MB = 10;
export const ALLOWED_FILE_TYPES = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

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
export const QUESTION_TYPES = [
    'recall',
    'conceptual',
    'application',
    'reasoning',
    'analytical',
] as const;
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

// ─── Unified Relation Type Ontology ─────────────────────────────────────────
//
// Merged from Study-Lens (Groq extraction) and IPD (triple_verifier.py).
// Used in:
//   • src/config/prompts.ts     — KG_EXTRACTOR system prompt
//   • src/lib/kg-builder.ts     — dynamic Cypher relation creation
//   • backend triple_verifier.py — ALLOWED_PREDICATES
//
// Bloom's Taxonomy mapping:
//   1 = Remember  2 = Understand  3 = Apply  4 = Analyze

export const RELATION_TYPES = [
    // ── Shared ────────────────────────────────────────────────────────────
    'IS_A',           // Classification/taxonomy
    'REQUIRES',       // Prerequisite
    'PART_OF',        // Composition
    'USED_FOR',       // Function/purpose
    'RELATES_TO',     // Fallback/generic

    // ── Study-Lens additions ──────────────────────────────────────────────
    'CAUSES',         // Cause-effect
    'DEFINES',        // Definitions
    'CONTRASTS_WITH', // Comparison
    'EXAMPLE_OF',     // Exemplification
    'FEATURE_OF',     // Properties
    'PRECEDES',       // Temporal sequence
    'EXTENSION_OF',   // Advanced→basic

    // ── IPD additions ─────────────────────────────────────────────────────
    'FOUND_IN',          // Location/discovery
    'LOCATED_IN',        // Spatial location
    'CONTAINS',          // Containment
    'CHARACTERIZED_BY',  // Characterization
    'DISCOVERED_BY',     // Historical attribution
    'BUILT_BY',          // Construction/creation
    'PRODUCED_BY',       // Production
    'SUPPLIED_BY',       // Supply chains
    'TRADED_BY',         // Commerce/trade
    'LED_TO',            // Historical causation
] as const;

export type RelationType = (typeof RELATION_TYPES)[number];

/** Maps each relation type to a Bloom's Taxonomy cognitive level (1–4). */
export const RELATION_BLOOM_MAP: Record<RelationType, number> = {
    // Remember (level 1) — simple retrieval / labelling
    IS_A: 1,
    FOUND_IN: 1,
    LOCATED_IN: 1,
    DISCOVERED_BY: 1,
    BUILT_BY: 1,
    RELATES_TO: 1,

    // Understand (level 2) — explain / describe
    REQUIRES: 2,
    PART_OF: 2,
    DEFINES: 2,
    EXAMPLE_OF: 2,
    CONTAINS: 2,
    CHARACTERIZED_BY: 2,
    PRECEDES: 2,
    LED_TO: 2,
    PRODUCED_BY: 2,
    SUPPLIED_BY: 2,
    TRADED_BY: 2, // could be 3 for trade-route analysis

    // Apply (level 3)
    USED_FOR: 3,
    FEATURE_OF: 3,
    CONTRASTS_WITH: 3,
    EXTENSION_OF: 3,

    // Analyse (level 4)
    CAUSES: 4,
};

/** Human-readable labels for UI rendering. */
export const RELATION_LABELS: Record<RelationType, string> = {
    IS_A: 'is a type of',
    REQUIRES: 'requires',
    PART_OF: 'is part of',
    USED_FOR: 'is used for',
    RELATES_TO: 'relates to',
    CAUSES: 'causes',
    DEFINES: 'defines',
    CONTRASTS_WITH: 'contrasts with',
    EXAMPLE_OF: 'is an example of',
    FEATURE_OF: 'is a feature of',
    PRECEDES: 'precedes',
    EXTENSION_OF: 'is an extension of',
    FOUND_IN: 'is found in',
    LOCATED_IN: 'is located in',
    CONTAINS: 'contains',
    CHARACTERIZED_BY: 'is characterized by',
    DISCOVERED_BY: 'was discovered by',
    BUILT_BY: 'was built by',
    PRODUCED_BY: 'is produced by',
    SUPPLIED_BY: 'is supplied by',
    TRADED_BY: 'is traded by',
    LED_TO: 'led to',
};

// ─── Misconception Severity ──────────────────────────────────────────────────

export const SEVERITY_LEVELS = ['CORRECT', 'CLOSE', 'PARTIAL', 'CRITICAL'] as const;
export type SeverityLevel = (typeof SEVERITY_LEVELS)[number];

export const SEVERITY_COLORS: Record<SeverityLevel, string> = {
    CORRECT: 'var(--accent-success)',
    CLOSE: 'var(--accent-primary)',
    PARTIAL: 'var(--accent-warning)',
    CRITICAL: 'var(--accent-danger)',
};

export const SEVERITY_LABELS: Record<SeverityLevel, string> = {
    CORRECT: 'Correct',
    CLOSE: 'Close',
    PARTIAL: 'Partial',
    CRITICAL: 'Critical gap',
};