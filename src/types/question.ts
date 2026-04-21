export type QuestionType = 'recall' | 'conceptual' | 'application' | 'reasoning' | 'analytical';
export type DifficultyLevel = 1 | 2 | 3;
export type BloomLevel = 'Remember' | 'Understand' | 'Apply' | 'Analyze';

export interface Question {
    id: string;
    concept_id: string;
    type: QuestionType;
    difficulty: DifficultyLevel;
    text: string;
    options: string[];
    correct_answer: string;
    explanation: string;
    cognitive_level: number; // 1-4
    bloom_level: BloomLevel;
    format: 'mcq'; // only MCQ questions are supported
    // ── Graph-distractor fields (set when graph distractors are used) ──
    distractor_distances?: Record<string, number>; // { optionText: hopDistance }
    concept_title?: string;// used by misconception analysis
    is_spaced?: boolean;
}

export interface QuestionGenerationRequest {
    concept_id: string;
    concept_title: string;
    type: QuestionType;
    difficulty: DifficultyLevel;
    context: string;
    relatedConcepts?: string[];
    user_id?: string;
}

export interface QuestionResponse {
    question: Question;
    metadata: {
        generated_at: string;
        model: string;
        source_nodes: string[];
    };
}

export interface AnswerSubmission {
    question_id: string;
    concept_id: string;
    selected_answer: string;
    time_taken: number; // seconds
    confidence: number; // 0-1
}

export interface AnswerResult {
    correct: boolean;
    explanation: string;
    mastery_delta: number;
    new_mastery: number;
    // ── Misconception analysis (present when graph analysis ran) ──
    misconception?: {
        severity: 'CORRECT' | 'CLOSE' | 'PARTIAL' | 'CRITICAL';
        misconceptionLabel: string;
        gapDescription: string;
        correctExplanation: string;
        kgPath: string[];
    };
}