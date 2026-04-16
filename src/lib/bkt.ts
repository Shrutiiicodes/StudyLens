/**
 * BKT — Bayesian Knowledge Tracing
 *
 * Corbett, A.T., & Anderson, J.R. (1994).
 * Knowledge tracing: Modeling the acquisition of procedural knowledge.
 * User Modeling and User-Adapted Interaction, 4(4), 253–278.
 *
 * Replaces the EMA (Exponential Moving Average) mastery update for practice
 * and mastery modes. Gives a principled posterior belief over student knowledge
 * at each step, distinguishing guessing from knowing.
 *
 * BKT has 4 interpretable parameters per concept:
 *   P(L₀) — prior: probability the student already knows it before any attempt
 *   P(T)   — learning: probability of learning on each attempt (transition)
 *   P(S)   — slip: probability of wrong answer given student knows it
 *   P(G)   — guess: probability of correct answer given student does NOT know it
 */

// ─── Types ───

export interface BKTParams {
    p_l0: number;  // Prior knowledge probability (0–1)
    p_t: number;   // Learning/transition probability (0–1)
    p_s: number;   // Slip probability (0–1)
    p_g: number;   // Guess probability (0–1)
}

export interface BKTState {
    p_knows: number;    // Current posterior P(knows) (0–1)
    params: BKTParams;
}

// ─── Default Parameters ───
// Calibrated from Corbett & Anderson (1994) and common BKT literature.
// For production: these should be fitted per-concept from student response data
// using EM (Expectation-Maximisation) via pyBKT or equivalent.
/**
 * Production BKT parameters for CBSE factual/conceptual MCQ content.
 *
 * Calibrated from Baker, R.S.J.d., Corbett, A.T., & Aleven, V. (2008).
 * More accurate student modeling through contextual estimation of slip
 * and guess probabilities in Bayesian Knowledge Tracing.
 * Proceedings of ITS 2008, pp. 406–415.
 *
 * Domain mapping rationale:
 *   p_l0 = 0.25 — lower than algebra default; CBSE students start each
 *                 new topic with near-zero prior knowledge
 *   p_t  = 0.12 — higher than algebra; declarative/factual recall learns
 *                 faster per attempt than procedural algebra skills
 *   p_s  = 0.08 — lower than algebra; 4-option MCQ reduces careless errors
 *                 compared to open-ended problem solving
 *   p_g  = 0.25 — 4-option MCQ has a 25% theoretical guess floor
 *                 (matches information-theoretic lower bound for 1/k options)
 *
 * These are default priors. Per-concept parameters should be fitted
 * using Expectation-Maximisation (EM) via POST /api/irt/fit once
 * sufficient response data has been collected (≥30 attempts per concept).
 */
export const DEFAULT_BKT_PARAMS: BKTParams = {
    p_l0: 0.25,  // Prior: 25% chance student already knows a new CBSE topic
    p_t: 0.12,  // Learning: 12% chance of learning per attempt (declarative content)
    p_s: 0.08,  // Slip: 8% chance of wrong despite knowing (MCQ careless error)
    p_g: 0.25,  // Guess: 25% floor for 4-option MCQ (1/k theoretical minimum)
};

// ─── Core BKT Update ───

/**
 * bktUpdate
 * Given current P(knows) and whether the student answered correctly,
 * returns the updated P(knows) after one observation.
 *
 * Step 1 — Bayesian update (observation):
 *   If correct:   P(knows | correct) = P(knows) × (1−S) / P(correct)
 *   If incorrect: P(knows | wrong)   = P(knows) × S    / P(wrong)
 *
 * Step 2 — Learning transition:
 *   P(knows_next) = P(knows | obs) + (1 − P(knows | obs)) × P(T)
 *
 * @param pKnows  - Current P(knows) before this attempt (0–1)
 * @param correct - Whether the student answered correctly
 * @param params  - BKT parameters (default: DEFAULT_BKT_PARAMS)
 * @returns Updated P(knows) after the observation and learning step
 */
export function bktUpdate(
    pKnows: number,
    correct: boolean,
    params: BKTParams = DEFAULT_BKT_PARAMS
): number {
    const { p_s, p_g, p_t } = params;

    // P(correct) = P(knows) × (1−S) + P(not knows) × G
    const pCorrect = pKnows * (1 - p_s) + (1 - pKnows) * p_g;
    const pWrong = pKnows * p_s + (1 - pKnows) * (1 - p_g);

    // Bayesian posterior after observation
    let pKnowsGivenObs: number;
    if (correct) {
        pKnowsGivenObs = pCorrect > 0
            ? (pKnows * (1 - p_s)) / pCorrect
            : pKnows;
    } else {
        pKnowsGivenObs = pWrong > 0
            ? (pKnows * p_s) / pWrong
            : pKnows;
    }

    // Learning transition: student may learn even after a wrong answer
    const pKnowsNext = pKnowsGivenObs + (1 - pKnowsGivenObs) * p_t;

    return Math.max(0, Math.min(1, pKnowsNext));
}

/**
 * bktUpdateSequence
 * Runs BKT over a sequence of attempts and returns the full P(knows) history.
 *
 * @param initialPKnows - Starting P(knows), typically P(L₀) for a new concept
 * @param attempts      - Array of boolean outcomes (true = correct)
 * @param params        - BKT parameters
 * @returns Array of P(knows) values after each attempt (length = attempts.length)
 */
export function bktUpdateSequence(
    initialPKnows: number,
    attempts: boolean[],
    params: BKTParams = DEFAULT_BKT_PARAMS
): number[] {
    const history: number[] = [];
    let pKnows = initialPKnows;

    for (const correct of attempts) {
        pKnows = bktUpdate(pKnows, correct, params);
        history.push(pKnows);
    }

    return history;
}

/**
 * bktToMastery
 * Converts BKT posterior P(knows) (0–1) to mastery score (0–100).
 * This maps directly to the mastery scale used in the rest of the system.
 */
export function bktToMastery(pKnows: number): number {
    return Math.round(Math.max(0, Math.min(1, pKnows)) * 100);
}

/**
 * masteryToBKT
 * Converts mastery score (0–100) to BKT P(knows) (0–1).
 * Used to initialise BKT from an existing mastery score in the DB.
 */
export function masteryToBKT(mastery: number): number {
    return Math.max(0, Math.min(1, mastery / 100));
}

/**
 * bktMasteryUpdate
 * Drop-in replacement for the EMA-based updateMastery function.
 * Takes the current mastery score (0–100), the correctness of the latest attempt,
 * and returns the new mastery score (0–100).
 *
 * Use this in practice and mastery modes instead of EMA.
 * For diagnostic mode, keep the direct score assignment (score × 100).
 *
 * @param currentMastery - Current mastery score (0–100)
 * @param correct        - Whether the student answered correctly
 * @param params         - BKT parameters per concept (default used if not fitted)
 * @returns New mastery score (0–100)
 */
export function bktMasteryUpdate(
    currentMastery: number,
    correct: boolean,
    params: BKTParams = DEFAULT_BKT_PARAMS
): number {
    const pKnows = masteryToBKT(currentMastery);
    const updatedPKnows = bktUpdate(pKnows, correct, params);
    return bktToMastery(updatedPKnows);
}

/**
 * bktMasteryUpdateFromResults
 * Runs BKT over an entire session's results and returns the final mastery score.
 * Equivalent to running bktMasteryUpdate sequentially for each question.
 *
 * @param currentMastery - Current mastery score (0–100) before the session
 * @param results        - Array of {correct} from QuestionResult[]
 * @param params         - BKT parameters
 * @returns Final mastery score after the full session (0–100)
 */
export function bktMasteryUpdateFromResults(
    currentMastery: number,
    results: { correct: boolean }[],
    params: BKTParams = DEFAULT_BKT_PARAMS
): number {
    if (results.length === 0) return currentMastery;

    let pKnows = masteryToBKT(currentMastery);
    for (const r of results) {
        pKnows = bktUpdate(pKnows, r.correct, params);
    }
    return bktToMastery(pKnows);
}