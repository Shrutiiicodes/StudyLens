/**
 * Personalization Engine
 * 
 * Implements the EXACT mathematical scoring system for Study Lens.
 * All formulas are documented inline.
 */

import {
    DIAGNOSTIC_WEIGHTS,
    PRACTICE_WEIGHTS,
    MASTERY_WEIGHTS,
    SPACED_WEIGHTS,
    SAI_WEIGHTS,
    LAMBDA_PRACTICE,
    LAMBDA_MASTERY,
    LAMBDA_SPACED,
    GAMMA_FORGETTING,
} from '@/config/constants';
import { AssessmentMode } from '@/types/student';
import { QuestionResult, StudentAbilityIndex, MasteryUpdate, DifficultyDistribution } from '@/types/mastery';

// ─── Core Components ───

/**
 * Accuracy: Acc = A ∈ {0, 1}
 */
export function accuracy(correct: boolean): number {
    return correct ? 1 : 0;
}

/**
 * Cognitive Depth: CD = CL_q / 2.5
 * Where CL_q ∈ {1, 2, 3, 4}
 */
export function cognitiveDepth(cognitiveLevel: number): number {
    return Math.min(cognitiveLevel, 4) / 2.5;
}

/**
 * Difficulty Weight: DW = D_q / 3
 * Where D_q ∈ {1, 2, 3}
 */
export function difficultyWeight(difficulty: number): number {
    return Math.min(difficulty, 3) / 3;
}

/**
 * Speed Efficiency: SE = min(1, T_exp / T)
 * Where T_exp is expected time, T is actual time
 */
export function speedEfficiency(expectedTime: number, actualTime: number): number {
    if (actualTime <= 0) return 1;
    return Math.min(1, expectedTime / actualTime);
}

/**
 * Confidence Calibration: CC = 1 - |A - C_f|
 * Where A ∈ {0,1} and C_f ∈ [0,1]
 */
export function confidenceCalibration(correct: boolean, confidence: number): number {
    const a = correct ? 1 : 0;
    return 1 - Math.abs(a - Math.max(0, Math.min(1, confidence)));
}

/**
 * Misconception Penalty:
 * MF = misconception_frequency / total_attempts
 * MP = 1 - MF
 */
export function misconceptionPenalty(
    misconceptionFrequency: number,
    totalAttempts: number
): number {
    if (totalAttempts <= 0) return 1;
    const mf = misconceptionFrequency / totalAttempts;
    return 1 - mf;
}

// ─── Scoring Functions ───

/**
 * Unified Score:
 * Simple accuracy-based scoring for all stages.
 * returns value between 0 and 1.
 */
export function calculateUnifiedScore(results: QuestionResult[]): number {
    if (results.length === 0) return 0;
    const n = results.length;
    const avgAcc = results.reduce((s, r) => s + accuracy(r.correct), 0) / n;
    return avgAcc;
}

/**
 * Spaced Reinforcement Score:
 * TW = 1 - e^(-γΔt)
 * RS = 0.5*Acc + 0.3*TW + 0.2*SE
 */
export function spacedReinforcementScore(
    result: QuestionResult,
    hoursElapsed: number
): number {
    const acc = accuracy(result.correct);
    const tw = 1 - Math.exp(-GAMMA_FORGETTING * hoursElapsed);
    const se = speedEfficiency(getExpectedTime(result.difficulty), result.time_taken);

    return (
        SPACED_WEIGHTS.accuracy * acc +
        SPACED_WEIGHTS.time_weight * tw +
        SPACED_WEIGHTS.speed_efficiency * se
    );
}

// ─── Mastery Update ───

/**
 * Mastery Update Formula:
 * M_new = (1 - λ)*M_old + λ*(100 * Score)
 * 
 * λ values:
 * - Practice: 0.2
 * - Mastery: 0.35
 * - Spaced: 0.5
 */
export function updateMastery(
    currentMastery: number,
    score: number,
    mode: AssessmentMode
): MasteryUpdate {
    const lambdaMap: Record<AssessmentMode, number> = {
        diagnostic: 1.0, // Diagnostic sets initial mastery
        practice: LAMBDA_PRACTICE,
        mastery: LAMBDA_MASTERY,
    };

    const lambda = lambdaMap[mode];

    let newMastery: number;
    if (mode === 'diagnostic') {
        newMastery = Math.round(100 * score);
    } else {
        newMastery = Math.round((1 - lambda) * currentMastery + lambda * (100 * score));
    }

    // Clamp between 0 and 100
    newMastery = Math.max(0, Math.min(100, newMastery));

    return {
        old_score: currentMastery,
        new_score: newMastery,
        delta: newMastery - currentMastery,
        mode,
        timestamp: new Date().toISOString(),
    };
}

// ─── Student Ability Index ───

/**
 * SAI = 0.5*M + 0.2*Trend + 0.2*GlobalAcc + 0.1*Calibration
 * 
 * Trend = slope of last 10 mastery updates
 */
export function calculateSAI(
    averageMastery: number,
    masteryHistory: number[], // Last 10+ mastery scores
    globalAccuracy: number,   // Overall accuracy 0-1
    avgCalibration: number    // Average confidence calibration 0-1
): StudentAbilityIndex {
    // Calculate trend (slope of linear regression on last 10 scores)
    const recentHistory = masteryHistory.slice(-10);
    const trend = calculateTrend(recentHistory);

    // Normalize trend to 0-100 scale
    const normalizedTrend = Math.max(0, Math.min(100, 50 + trend * 10));

    const sai =
        SAI_WEIGHTS.mastery * averageMastery +
        SAI_WEIGHTS.trend * normalizedTrend +
        SAI_WEIGHTS.global_accuracy * (globalAccuracy * 100) +
        SAI_WEIGHTS.calibration * (avgCalibration * 100);

    return {
        sai: Math.round(Math.max(0, Math.min(100, sai))),
        mastery_component: averageMastery,
        trend_component: normalizedTrend,
        accuracy_component: globalAccuracy * 100,
        calibration_component: avgCalibration * 100,
    };
}

/**
 * Calculate the slope (trend) of a series of values.
 * Uses simple linear regression.
 */
function calculateTrend(values: number[]): number {
    if (values.length < 2) return 0;

    const n = values.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

    for (let i = 0; i < n; i++) {
        sumX += i;
        sumY += values[i];
        sumXY += i * values[i];
        sumX2 += i * i;
    }

    const denominator = n * sumX2 - sumX * sumX;
    if (denominator === 0) return 0;

    return (n * sumXY - sumX * sumY) / denominator;
}

// ─── Difficulty Distribution ───

/**
 * Difficulty Distribution Engine
 * E(M) = max(0, 0.7 - 0.006M)
 * Med(M) = 0.3 + 0.002M
 * H(M) = 1 - (E + Med)
 */
export function getDifficultyDistribution(mastery: number): DifficultyDistribution {
    const m = Math.max(0, Math.min(100, mastery));

    const easy = Math.max(0, 0.7 - 0.006 * m);
    const medium = 0.3 + 0.002 * m;
    const hard = Math.max(0, 1 - (easy + medium));

    const total = easy + medium + hard;
    return {
        easy: easy / total,
        medium: medium / total,
        hard: hard / total,
    };
}

/**
 * Sample next question difficulty probabilistically.
 */
export function sampleDifficulty(mastery: number): 1 | 2 | 3 {
    const dist = getDifficultyDistribution(mastery);
    const rand = Math.random();

    if (rand < dist.easy) return 1;
    if (rand < dist.easy + dist.medium) return 2;
    return 3;
}

// ─── Helper ───

function getExpectedTime(difficulty: number): number {
    const times: Record<number, number> = { 1: 30, 2: 60, 3: 90 };
    return times[difficulty] || 60;
}
