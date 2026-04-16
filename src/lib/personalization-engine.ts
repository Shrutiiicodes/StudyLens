/**
 * Personalization Engine
 *
 * Implements the mathematical scoring system for Study Lens.
 * All formulas are documented inline.
 *
 * Mastery update now uses BKT (Bayesian Knowledge Tracing) for practice
 * and mastery modes, replacing the EMA (Exponential Moving Average).
 * Diagnostic mode still uses direct score assignment (unchanged).
 *
 * Reference: Corbett & Anderson (1994).
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
import {
    bktMasteryUpdateFromResults,
    bktUpdate,
    masteryToBKT,
    bktToMastery,
    DEFAULT_BKT_PARAMS,
    BKTParams,
} from './bkt';

// ─── Core Components ───

/** Accuracy: Acc = A ∈ {0, 1} */
export function accuracy(correct: boolean): number {
    return correct ? 1 : 0;
}

/** Cognitive Depth: CD = CL_q / 2.5, where CL_q ∈ {1, 2, 3, 4} */
export function cognitiveDepth(cognitiveLevel: number): number {
    return Math.min(cognitiveLevel, 4) / 2.5;
}

/** Difficulty Weight: DW = D_q / 3, where D_q ∈ {1, 2, 3} */
export function difficultyWeight(difficulty: number): number {
    return Math.min(difficulty, 3) / 3;
}

/** Speed Efficiency: SE = min(1, T_exp / T) */
export function speedEfficiency(expectedTime: number, actualTime: number): number {
    if (actualTime <= 0) return 1;
    return Math.min(1, expectedTime / actualTime);
}

/** Confidence Calibration: CC = 1 - |A - C_f| */
export function confidenceCalibration(correct: boolean, confidence: number): number {
    const a = correct ? 1 : 0;
    return 1 - Math.abs(a - Math.max(0, Math.min(1, confidence)));
}

/** Misconception Penalty: MP = 1 - (misconception_frequency / total_attempts) */
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
 * Unified Score — simple accuracy-based scoring for all stages.
 * Returns 0–1.
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
 * updateMastery
 *
 * Mode behaviour:
 *   diagnostic — Sets mastery directly from score (unchanged).
 *   practice   — Uses BKT (Corbett & Anderson, 1994) to update P(knows).
 *   mastery    — Uses BKT with the same parameters.
 *
 * BKT replaces the previous EMA formula:
 *   EMA: M_new = (1−λ)×M_old + λ×(100×Score)
 *
 * BKT is preferred because it:
 *   - Distinguishes guessing from knowing via slip/guess parameters
 *   - Produces a principled posterior belief over knowledge state
 *   - Is directly comparable to published ITS baselines (DKT, DKVMN, AKT)
 *
 * @param currentMastery - Current mastery score (0–100)
 * @param score          - Session score (0–1)
 * @param mode           - Assessment mode
 * @param results        - Full QuestionResult list for per-attempt BKT sequence
 * @param bktParams      - Per-concept BKT params (default used if not yet fitted)
 */
export function updateMastery(
    currentMastery: number,
    score: number,
    mode: AssessmentMode,
    results?: QuestionResult[],
    bktParams: BKTParams = DEFAULT_BKT_PARAMS
): MasteryUpdate {
    let newMastery: number;

    if (mode === 'diagnostic') {
        // Diagnostic: set mastery directly from score (unchanged)
        newMastery = Math.round(100 * score);
    } else {
        // Practice & Mastery: use BKT over the session's attempt sequence
        if (results && results.length > 0) {
            // Preferred path: run BKT sequentially over all attempts
            newMastery = bktMasteryUpdateFromResults(currentMastery, results, bktParams);
        } else {
            // Fallback: single BKT update treating overall score as proxy correctness
            // (score >= 0.5 treated as "correct" for the single-step update)
            const pKnows = masteryToBKT(currentMastery);
            const updatedPKnows = bktUpdate(pKnows, score >= 0.5, bktParams);
            newMastery = bktToMastery(updatedPKnows);
        }
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
 * Trend = slope of linear regression on last 10 scores
 */
export function calculateSAI(
    averageMastery: number,
    masteryHistory: number[],
    globalAccuracy: number,   // 0–1
    avgCalibration: number    // 0–1
): StudentAbilityIndex {
    const recentHistory = masteryHistory.slice(-10);
    const trend = calculateTrend(recentHistory);
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

/** Sample next question difficulty probabilistically. */
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