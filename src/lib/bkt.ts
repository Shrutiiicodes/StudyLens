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
export const DEFAULT_BKT_PARAMS: BKTParams = {
    p_l0: 0.30,  // 30% prior chance student already knows it
    p_t: 0.09,  // 9% chance of learning on each attempt
    p_s: 0.10,  // 10% slip rate
    p_g: 0.20,  // 20% guess rate
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