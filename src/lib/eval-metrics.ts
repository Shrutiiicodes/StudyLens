/**
 * ═══════════════════════════════════════════
 * STUDY LENS — Evaluation Metrics Engine
 * ═══════════════════════════════════════════
 *
 * Implements all metrics from the evaluation plan:
 * - Group 3: Assessment Metrics (FAS, RCI, WBS, CCMS, MSS, LIP)
 * - Group 4: Student Model Metrics (SAI, Convergence, Calibration)
 * - Group 5: System-level Metrics (Mastery Improvement Rate, TTM)
 */

// ─── Types ───

export interface AttemptResult {
    correct: boolean;
    confidence: number;       // 0–1
    time_taken: number;       // seconds
    question_type: string;    // 'recall' | 'conceptual' | 'application' | 'reasoning' | 'analytical'
    cognitive_level: number;  // 1–4 (Bloom's level)
    difficulty: number;       // 1–3
}

export interface SessionMetrics {
    fas: number;              // Fractional Assessment Score
    wbs: number;              // Weighted Bloom Score
    ccms: number;             // Composite Confidence Mastery Score
    mss: number;              // Mastery Sensitivity Score
    lip: number;              // Learning Improvement Priority
    rci_avg: number;          // Average Response Confidence Index
    calibration_error: number;// Average |correct - confidence|
}

export interface StudentModelMetrics {
    sai: number;
    convergence_rate: number; // questions until mastery stabilises
    calibration_error: number;
}

export interface SystemMetrics {
    avg_mastery: number;
    avg_convergence: number;
    mastery_improvement_rate: number;   // % of students reaching > 75
    avg_ccms_with_learnit: number;
    avg_ccms_without_learnit: number;
    avg_time_to_mastery: number;        // sessions
}

// ─── Group 3: Assessment Metrics ───

/**
 * FAS — Fractional Assessment Score
 * Weights questions by type complexity.
 *
 * FAS = Σ(item_weight × correct) / Σ(item_weights)
 *
 * Weights:
 *   recall       → 1.0
 *   conceptual   → 1.2  (maps to "classification")
 *   application  → 1.5  (maps to "negation" / higher order)
 *   reasoning    → 1.5
 *   analytical   → 2.0
 */
export function computeFAS(results: AttemptResult[]): number {
    const weights: Record<string, number> = {
        recall: 1.0,
        conceptual: 1.2,
        application: 1.5,
        reasoning: 1.5,
        analytical: 2.0,
    };

    if (results.length === 0) return 0;

    const totalWeight = results.reduce(
        (sum, r) => sum + (weights[r.question_type] ?? 1.0),
        0
    );
    const scored = results.reduce(
        (sum, r) => sum + (r.correct ? (weights[r.question_type] ?? 1.0) : 0),
        0
    );

    return totalWeight > 0 ? scored / totalWeight : 0;
}

/**
 * RCI — Response Confidence Index
 * How fast was this response relative to the student's average?
 *
 * RCI = actual_time / student_avg_time
 * < 1.0 → faster than average (confident)
 * > 1.0 → slower than average (uncertain)
 */
export function computeRCI(actualTime: number, studentAvgTime: number): number {
    if (studentAvgTime <= 0) return 1.0;
    return actualTime / studentAvgTime;
}

/**
 * Compute average RCI across all results given each result's RCI.
 */
export function computeAvgRCI(results: AttemptResult[]): number {
    if (results.length === 0) return 1.0;
    const avgTime =
        results.reduce((sum, r) => sum + r.time_taken, 0) / results.length;
    const rcis = results.map((r) => computeRCI(r.time_taken, avgTime));
    return rcis.reduce((sum, v) => sum + v, 0) / rcis.length;
}

/**
 * WBS — Weighted Bloom Score
 * Weights correctness by Bloom's cognitive level.
 *
 * WBS = Σ(bloom_weight × correct) / max_possible
 *
 * Bloom weights:
 *   Level 1 (Remember/recall)     → 1.0
 *   Level 2 (Understand/conceptual) → 1.5
 *   Level 3 (Apply/application)    → 2.0
 *   Level 4 (Analyse/analytical)   → 2.5
 */
export function computeWBS(results: AttemptResult[]): number {
    const bloomWeights: Record<number, number> = {
        1: 1.0,
        2: 1.5,
        3: 2.0,
        4: 2.5,
    };

    if (results.length === 0) return 0;

    const maxPossible = results.reduce(
        (sum, r) => sum + (bloomWeights[r.cognitive_level] ?? 1.0),
        0
    );
    const scored = results.reduce(
        (sum, r) =>
            sum + (r.correct ? (bloomWeights[r.cognitive_level] ?? 1.0) : 0),
        0
    );

    return maxPossible > 0 ? scored / maxPossible : 0;
}

/**
 * CCMS — Composite Confidence Mastery Score
 * Combines FAS, WBS, and the raw session score.
 *
 * CCMS = (0.15 × FAS) + (0.25 × WBS) + (0.60 × session_score_normalised)
 *
 * session_score is 0–100; we normalise to 0–1 internally.
 * Returns a value 0–1.
 */
export function computeCCMS(
    fas: number,
    wbs: number,
    sessionScore: number // 0–100
): number {
    return 0.15 * fas + 0.25 * wbs + 0.6 * (sessionScore / 100);
}

/**
 * MSS — Mastery Sensitivity Score
 * Penalises confident-and-wrong answers more than uncertain-and-wrong.
 *
 * MSS = Σ(confidence_weight × wrong) / total_attempts
 *
 * Confidence weights for wrong answers:
 *   confidence > 0.7  → 2.0  (dangerously overconfident)
 *   confidence 0.4–0.7 → 1.5
 *   confidence < 0.4  → 1.0  (probably guessing)
 */
export function computeMSS(results: AttemptResult[]): number {
    if (results.length === 0) return 0;

    const weightedWrong = results.reduce((sum, r) => {
        if (r.correct) return sum; // Only penalise wrong answers
        let weight = 1.0;
        if (r.confidence > 0.7) weight = 2.0;
        else if (r.confidence >= 0.4) weight = 1.5;
        return sum + weight;
    }, 0);

    return weightedWrong / results.length;
}

/**
 * LIP — Learning Improvement Priority
 * Determines how urgently a student needs to revisit this concept.
 *
 * LIP = (1 - CCMS) × 0.5 + MSS_normalised × 0.5
 *
 * MSS is normalised to 0–1 by dividing by its max possible value (2.0).
 * Returns 0–1 where 1 = highest priority.
 */
export function computeLIP(ccms: number, mss: number): number {
    const maxMSS = 2.0;
    const normMSS = Math.min(1, mss / maxMSS);
    return (1 - Math.max(0, Math.min(1, ccms))) * 0.5 + normMSS * 0.5;
}

// ─── Group 4: Student Model Metrics ───

/**
 * Calibration Error
 * Measures how well a student knows what they know.
 *
 * CE = avg(|correct - confidence|)
 * 0 → perfectly calibrated
 * 1 → maximally miscalibrated
 */
export function computeCalibrationError(results: AttemptResult[]): number {
    if (results.length === 0) return 0;
    const total = results.reduce(
        (sum, r) => sum + Math.abs((r.correct ? 1 : 0) - r.confidence),
        0
    );
    return total / results.length;
}

/**
 * Convergence Rate
 * How many questions until mastery stabilises (delta < threshold).
 *
 * Returns the index of first stabilisation, or the full length if never.
 */
export function computeConvergenceRate(
    masteryHistory: number[],
    threshold: number = 2.0
): number {
    if (masteryHistory.length < 2) return masteryHistory.length;

    for (let i = 1; i < masteryHistory.length; i++) {
        if (Math.abs(masteryHistory[i] - masteryHistory[i - 1]) < threshold) {
            return i;
        }
    }
    return masteryHistory.length;
}

/**
 * SAI — Student Ability Index
 * Holistic score combining mastery, trend, accuracy, calibration.
 *
 * SAI = 0.5 × avg_mastery
 *     + 0.2 × normalised_trend
 *     + 0.2 × global_accuracy × 100
 *     + 0.1 × avg_calibration × 100
 *
 * normalised_trend: slope of last 10 scores, mapped to 0–100 range.
 * Returns 0–100.
 */
export function computeSAI(
    averageMastery: number,
    masteryHistory: number[],
    globalAccuracy: number,  // 0–1
    avgCalibration: number   // 0–1 (1 = perfectly calibrated = low error)
): number {
    const recent = masteryHistory.slice(-10);
    const trend = linearRegressionSlope(recent);
    const normalisedTrend = Math.max(0, Math.min(100, 50 + trend * 10));

    const sai =
        0.5 * averageMastery +
        0.2 * normalisedTrend +
        0.2 * (globalAccuracy * 100) +
        0.1 * (avgCalibration * 100);

    return Math.round(Math.max(0, Math.min(100, sai)));
}

// ─── Group 5: System Metrics ───

/**
 * Mastery Improvement Rate
 * Percentage of students who reached mastery > 75 after using the system.
 */
export function computeMasteryImprovementRate(
    finalMasteryScores: number[],
    threshold: number = 75
): number {
    if (finalMasteryScores.length === 0) return 0;
    const above = finalMasteryScores.filter((s) => s > threshold).length;
    return above / finalMasteryScores.length;
}

/**
 * Average Time to Mastery
 * Mean number of sessions to reach mastery > 75.
 */
export function computeAvgTimeToMastery(
    sessionCountsToMastery: number[]
): number {
    if (sessionCountsToMastery.length === 0) return 0;
    return (
        sessionCountsToMastery.reduce((sum, v) => sum + v, 0) /
        sessionCountsToMastery.length
    );
}

/**
 * CCMS improvement comparison:
 * Did students who used LearnIt perform better on second attempt?
 */
export function computeCCMSImprovement(
    withLearnIt: number[],
    withoutLearnIt: number[]
): { withLearnIt: number; withoutLearnIt: number; delta: number } {
    const avg = (arr: number[]) =>
        arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    const wl = avg(withLearnIt);
    const wol = avg(withoutLearnIt);

    return {
        withLearnIt: wl,
        withoutLearnIt: wol,
        delta: wl - wol,
    };
}

// ─── Convenience: Compute All Session Metrics ───

/**
 * computeAllSessionMetrics
 * Given a list of attempt results and the current session score (0–100),
 * returns all Group 3 metrics in one call.
 */
export function computeAllSessionMetrics(
    results: AttemptResult[],
    sessionScore: number // 0–100
): SessionMetrics {
    const fas = computeFAS(results);
    const wbs = computeWBS(results);
    const ccms = computeCCMS(fas, wbs, sessionScore);
    const mss = computeMSS(results);
    const lip = computeLIP(ccms, mss);
    const rci_avg = computeAvgRCI(results);
    const calibration_error = computeCalibrationError(results);

    return { fas, wbs, ccms, mss, lip, rci_avg, calibration_error };
}

// ─── Helpers ───

/**
 * Linear regression slope for a series.
 * Used internally by computeSAI for trend calculation.
 */
function linearRegressionSlope(values: number[]): number {
    const n = values.length;
    if (n < 2) return 0;

    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < n; i++) {
        sumX += i;
        sumY += values[i];
        sumXY += i * values[i];
        sumX2 += i * i;
    }

    const denom = n * sumX2 - sumX * sumX;
    if (denom === 0) return 0;
    return (n * sumXY - sumX * sumY) / denom;
}

/**
 * Map question_type to Bloom's cognitive level if cognitive_level isn't set.
 */
export function inferCognitiveLevel(questionType: string): number {
    const map: Record<string, number> = {
        recall: 1,
        conceptual: 2,
        application: 3,
        reasoning: 3,
        analytical: 4,
    };
    return map[questionType] ?? 1;
}