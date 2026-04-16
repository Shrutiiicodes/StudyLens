/**
 * ═══════════════════════════════════════════
 * STUDY LENS — Evaluation Metrics Engine
 * ═══════════════════════════════════════════
 *
 * Implements all metrics from the evaluation plan:
 * - Group 3: Assessment Metrics (FAS, RCI, WBS, CCMS, MSS, LIP)
 * - Group 4: Student Model Metrics (SAI, Convergence, Calibration)
 * - Group 5: System-level Metrics (Mastery Improvement Rate, TTM)
 * - Standard ITS Metrics: NLG, Brier Score, ECE, Log-Loss
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
    // ── Legacy custom metrics (kept for continuity) ──
    fas: number;              // Fractional Assessment Score
    wbs: number;              // Weighted Bloom Score
    ccms: number;             // Composite Confidence Mastery Score
    mss: number;              // Mastery Sensitivity Score
    lip: number;              // Learning Improvement Priority
    rci_avg: number;          // Average Response Confidence Index
    calibration_error: number;// Average |correct - confidence|

    // ── Standard ITS metrics (citable, benchmarkable) ──
    nlg: number;              // Normalized Learning Gain (Hake, 1998)
    brier_score: number;      // Brier Score — probabilistic penalty for confident-wrong answers
    ece: number;              // Expected Calibration Error (Guo et al., 2017)
    log_loss: number;         // Log-Loss — proxy for AUC-ROC on next-answer prediction
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
 *   conceptual   → 1.2
 *   application  → 1.5
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
 */
export function computeRCI(result: AttemptResult, avgTime: number): number {
    if (avgTime <= 0) return 1;
    const timeRatio = Math.min(2, result.time_taken / avgTime);
    const confidenceAdjusted = result.correct
        ? result.confidence * (1 / timeRatio)
        : result.confidence * timeRatio;
    return Math.max(0, Math.min(1, confidenceAdjusted));
}

export function computeAvgRCI(results: AttemptResult[]): number {
    if (results.length === 0) return 0;
    const avgTime = results.reduce((s, r) => s + r.time_taken, 0) / results.length;
    return results.reduce((sum, r) => sum + computeRCI(r, avgTime), 0) / results.length;
}

/**
 * WBS — Weighted Bloom Score
 * Weights correctness by Bloom's cognitive level.
 */
export function computeWBS(results: AttemptResult[]): number {
    if (results.length === 0) return 0;
    const maxPossible = results.reduce((sum, r) => sum + r.cognitive_level, 0);
    const scored = results.reduce(
        (sum, r) => sum + (r.correct ? r.cognitive_level : 0),
        0
    );
    return maxPossible > 0 ? scored / maxPossible : 0;
}

/**
 * CCMS — Composite Confidence Mastery Score
 * CCMS = (0.15 × FAS) + (0.25 × WBS) + (0.60 × session_score_normalised)
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
 */
export function computeMSS(results: AttemptResult[]): number {
    if (results.length === 0) return 0;

    const weightedWrong = results.reduce((sum, r) => {
        if (r.correct) return sum;
        let weight = 1.0;
        if (r.confidence > 0.7) weight = 2.0;
        else if (r.confidence >= 0.4) weight = 1.5;
        return sum + weight;
    }, 0);

    return weightedWrong / results.length;
}

/**
 * LIP — Learning Improvement Priority
 * LIP = (1 - CCMS) × 0.5 + MSS_normalised × 0.5
 */
export function computeLIP(ccms: number, mss: number): number {
    const maxMSS = 2.0;
    const normMSS = Math.min(1, mss / maxMSS);
    return (1 - Math.max(0, Math.min(1, ccms))) * 0.5 + normMSS * 0.5;
}

// ─── Group 4: Student Model Metrics ───

/**
 * Calibration Error
 * CE = avg(|correct - confidence|)
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
 * SAI = 0.5 × avg_mastery + 0.2 × normalised_trend
 *     + 0.2 × global_accuracy × 100 + 0.1 × avg_calibration × 100
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

// ─── Standard ITS Metrics ───

/**
 * NLG — Normalized Learning Gain (Hake, 1998)
 * NLG = (post - pre) / (100 - pre)
 *
 * Range: −∞ to 1.0 (negative = regression, 1.0 = perfect gain from pre-score)
 * Citation: Hake, R.R. (1998). Interactive-engagement versus traditional methods.
 *           American Journal of Physics, 66(1), 64–74.
 *
 * @param preMastery  - Mastery score BEFORE the session (0–100)
 * @param postMastery - Mastery score AFTER the session (0–100)
 */
export function computeNLG(preMastery: number, postMastery: number): number {
    if (preMastery >= 100) return 0; // Already at ceiling, no gain possible
    return (postMastery - preMastery) / (100 - preMastery);
}

/**
 * Brier Score (Brier, 1950)
 * BS = (1/N) × Σ(p_predicted − outcome)²
 *
 * Range: 0–1. Lower is better.
 * Penalises confident-wrong answers probabilistically.
 * Standard replacement for MSS in ITS literature.
 *
 * Citation: Brier, G.W. (1950). Verification of forecasts expressed in terms of probability.
 *           Monthly Weather Review, 78(1), 1–3.
 */
export function computeBrierScore(results: AttemptResult[]): number {
    if (results.length === 0) return 0;
    const total = results.reduce((sum, r) => {
        const outcome = r.correct ? 1 : 0;
        return sum + Math.pow(r.confidence - outcome, 2);
    }, 0);
    return total / results.length;
}

/**
 * ECE — Expected Calibration Error (Guo et al., 2017)
 * Bins predictions into M buckets. Computes weighted |accuracy − confidence| per bin.
 *
 * Range: 0–1. Lower is better. 0 = perfectly calibrated.
 * Standard replacement for raw calibration_error in ITS/ML literature.
 *
 * Citation: Guo, C., Pleiss, G., Sun, Y., & Weinberger, K.Q. (2017).
 *           On calibration of modern neural networks. ICML.
 *
 * @param M - Number of confidence bins (default: 10)
 */
export function computeECE(results: AttemptResult[], M: number = 10): number {
    if (results.length === 0) return 0;

    const bins: { sumConf: number; sumCorrect: number; count: number }[] =
        Array.from({ length: M }, () => ({ sumConf: 0, sumCorrect: 0, count: 0 }));

    for (const r of results) {
        const binIdx = Math.min(M - 1, Math.floor(r.confidence * M));
        bins[binIdx].sumConf += r.confidence;
        bins[binIdx].sumCorrect += r.correct ? 1 : 0;
        bins[binIdx].count += 1;
    }

    let ece = 0;
    for (const bin of bins) {
        if (bin.count === 0) continue;
        const avgConf = bin.sumConf / bin.count;
        const avgAcc = bin.sumCorrect / bin.count;
        ece += (bin.count / results.length) * Math.abs(avgAcc - avgConf);
    }
    return ece;
}

/**
 * Log-Loss (Cross-Entropy Loss)
 * LL = −(1/N) × Σ [y·log(p) + (1−y)·log(1−p)]
 *
 * Range: 0–∞. Lower is better.
 * Per-session proxy for AUC-ROC on next-answer prediction.
 * Used in: DKT (Piech et al., 2015), BKT literature, every knowledge tracing paper.
 *
 * For full AUC computation: store raw (confidence, outcome) pairs per attempt
 * and compute AUC-ROC across all sessions using scikit-learn or equivalent.
 */
export function computeLogLoss(results: AttemptResult[]): number {
    if (results.length === 0) return 0;
    const eps = 1e-7; // Avoid log(0)
    const total = results.reduce((sum, r) => {
        const p = Math.max(eps, Math.min(1 - eps, r.confidence));
        const y = r.correct ? 1 : 0;
        return sum + (y * Math.log(p) + (1 - y) * Math.log(1 - p));
    }, 0);
    return -total / results.length;
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
 * CCMS improvement comparison
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

    return { withLearnIt: wl, withoutLearnIt: wol, delta: wl - wol };
}

// ─── Convenience: Compute All Session Metrics ───

/**
 * computeAllSessionMetrics
 * Returns all Group 3 + standard ITS metrics for a session.
 *
 * @param results       - Per-attempt data
 * @param sessionScore  - Raw session score 0–100
 * @param preMastery    - Mastery BEFORE session (0–100) — used for NLG. Pass currentMastery.
 * @param postMastery   - Mastery AFTER session (0–100) — used for NLG. Pass masteryUpdate.new_score.
 */
export function computeAllSessionMetrics(
    results: AttemptResult[],
    sessionScore: number,
    preMastery: number = 0,
    postMastery: number = 0,
): SessionMetrics {
    const fas = computeFAS(results);
    const wbs = computeWBS(results);
    const ccms = computeCCMS(fas, wbs, sessionScore);
    const mss = computeMSS(results);
    const lip = computeLIP(ccms, mss);
    const rci_avg = computeAvgRCI(results);
    const calibration_error = computeCalibrationError(results);

    // Standard ITS metrics
    const nlg = computeNLG(preMastery, postMastery);
    const brier_score = computeBrierScore(results);
    const ece = computeECE(results);
    const log_loss = computeLogLoss(results);

    return {
        fas, wbs, ccms, mss, lip, rci_avg, calibration_error,
        nlg, brier_score, ece, log_loss,
    };
}

// ─── Helpers ───

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

/**
 * computeAUCROC
 * Computes AUC-ROC from a set of (confidence, correct) pairs.
 *
 * Uses the trapezoidal rule over the ROC curve.
 * Treats confidence as the predicted probability and correct as the binary label.
 *
 * Range: 0.5 (random) to 1.0 (perfect). Below 0.5 = worse than random.
 *
 * This is the standard system-level metric used in all knowledge tracing papers
 * (DKT: Piech et al. 2015, DKVMN, AKT, SAINT+).
 * Per-session proxy was log-loss; this is the true AUC across many sessions.
 *
 * @param pairs - Array of {confidence: number, correct: boolean} from attempts
 */
export function computeAUCROC(pairs: { confidence: number; correct: boolean }[]): number {
    if (pairs.length < 2) return 0.5; // insufficient data

    // Sort by confidence descending
    const sorted = [...pairs].sort((a, b) => b.confidence - a.confidence);

    const totalPos = pairs.filter(p => p.correct).length;
    const totalNeg = pairs.length - totalPos;

    if (totalPos === 0 || totalNeg === 0) return 0.5; // degenerate case

    let tp = 0, fp = 0;
    let prevTp = 0, prevFp = 0;
    let auc = 0;

    for (const p of sorted) {
        if (p.correct) tp++;
        else fp++;

        // Trapezoidal rule: area under curve segment
        const tpr = tp / totalPos; // true positive rate
        const fpr = fp / totalNeg; // false positive rate
        const prevTpr = prevTp / totalPos;
        const prevFpr = prevFp / totalNeg;

        auc += (fpr - prevFpr) * (tpr + prevTpr) / 2;

        prevTp = tp;
        prevFp = fp;
    }

    return Math.max(0, Math.min(1, Math.round(auc * 10000) / 10000));
}