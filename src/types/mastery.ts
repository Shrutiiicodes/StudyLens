import { AssessmentMode } from './student';
import { QuestionType } from './question';
export interface MasteryRecord {
    id: string;
    user_id: string;
    concept_id: string;
    mastery_score: number;
    last_updated: string;
}

export interface MasteryUpdate {
    old_score: number;
    new_score: number;
    delta: number;
    mode: AssessmentMode;
    timestamp: string;
}

export interface MasteryHistory {
    concept_id: string;
    concept_title: string;
    history: MasteryDataPoint[];
}

export interface MasteryDataPoint {
    score: number;
    timestamp: string;
    mode: AssessmentMode;
}

export interface DiagnosticResult {
    concept_id: string;
    initial_mastery: number;
    diagnostic_score: number;
    question_results: QuestionResult[];
    recommended_path: 'test_it' | 'learn_it';
}

export interface QuestionResult {
    question_id: string;
    correct: boolean;
    difficulty: number;
    cognitive_level: number;
    time_taken: number;
    confidence: number;
    concept_id?: string;
    question_type?: QuestionType;
}

export interface DifficultyDistribution {
    easy: number;
    medium: number;
    hard: number;
}

export interface StudentAbilityIndex {
    sai: number;
    mastery_component: number;
    trend_component: number;
    accuracy_component: number;
    calibration_component: number;
}

export interface ForgettingState {
    original_mastery: number;
    decayed_mastery: number;
    hours_elapsed: number;
    gamma: number;
}
