/**
 * IRT — Item Response Theory (Rasch Model)
 *
 * Rasch, G. (1960). Probabilistic models for some intelligence and attainment tests.
 * Danish Institute for Educational Research, Copenhagen.
 *
 * The Rasch model (1-parameter logistic, 1PL) estimates:
 *   - b_i  : Item difficulty parameter per question (real-valued, unbounded)
 *            b > 0 = harder than average, b < 0 = easier than average
 *   - θ_j  : Student ability (estimated from mastery, not fitted here)
 *
 * Probability of correct response:
 *   P(correct | θ, b) = 1 / (1 + exp(-(θ - b)))
 *
 * This replaces the LLM-assigned difficulty labels (easy/medium/hard) with
 * empirically calibrated difficulty parameters updated from student response data.
 *
 * Update rule (online MLE approximation):
 *   b_new = b_old + α × (P(correct | θ, b_old) - observed_correct)
 *
 * where α is a learning rate (default 0.1) and observed_correct ∈ {0, 1}.
 *
 * Relationship to existing difficulty levels:
 *   difficulty = 1 (easy)   → b initialised at −0.5
 *   difficulty = 2 (medium) → b initialised at  0.0
 *   difficulty = 3 (hard)   → b initialised at +0.5
 *
 * After accumulating enough responses, b converges to the true difficulty
 * independent of the original label — the IRT parameter self-calibrates.
 */

// ─── Types ───

export interface IRTState {
    difficulty_param: number;   // b_i — Rasch difficulty parameter
    response_count: number;     // n — number of attempts used to estimate b_i
}

export const DEFAULT_IRT_STATE: Record<number, IRTState> = {
    1: { difficulty_param: -0.5, response_count: 0 }, // easy
    2: { difficulty_param: 0.0, response_count: 0 }, // medium
    3: { difficulty_param: 0.5, response_count: 0 }, // hard
};

// ─── Core Rasch Functions ───

/**
 * raschProbability
 * P(correct | θ, b) = 1 / (1 + exp(-(θ - b)))
 *
 * @param theta  - Student ability estimate (derived from mastery: θ = logit(mastery/100))
 * @param b      - Item difficulty parameter
 */
export function raschProbability(theta: number, b: number): number {
    return 1 / (1 + Math.exp(-(theta - b)));
}

/**
 * masteryToTheta
 * Convert mastery score (0–100) to logit-scale ability θ.
 * θ = logit(p) = ln(p / (1 - p))
 * Clamps p away from 0 and 1 to avoid ±∞.
 */
export function masteryToTheta(mastery: number): number {
    const eps = 0.01;
    const p = Math.max(eps, Math.min(1 - eps, mastery / 100));
    return Math.log(p / (1 - p));
}

/**
 * updateDifficultyParam
 * Online MLE update for item difficulty b_i after one observation.
 *
 * b_new = b_old + α × (P(correct | θ, b_old) − observed)
 *
 * Intuition:
 *   - If the student (ability θ) was expected to get it right (P high)
 *     but got it wrong (observed = 0), b increases (item was harder than estimated).
 *   - If the student was expected to get it wrong (P low) but got it right,
 *     b decreases (item was easier than estimated).
 *
 * @param b            - Current difficulty parameter
 * @param theta        - Student ability estimate
 * @param correct      - Whether the student answered correctly
 * @param alpha        - Learning rate (default 0.1 — conservative for small samples)
 * @param responseCount - Number of previous responses (used to decay alpha)
 */
export function updateDifficultyParam(
    b: number,
    theta: number,
    correct: boolean,
    alpha: number = 0.1,
    responseCount: number = 0
): number {
    // Decay learning rate as more data accumulates (Fisher scoring approximation)
    // α_effective = α / sqrt(n + 1)
    const effectiveAlpha = alpha / Math.sqrt(responseCount + 1);

    const pCorrect = raschProbability(theta, b);
    const observed = correct ? 1 : 0;

    // b increases if observed < expected (harder than thought)
    const bNew = b + effectiveAlpha * (pCorrect - observed);

    // Clamp to reasonable range: −3 to +3 (covers 99.7% of real item difficulties)
    return Math.max(-3, Math.min(3, bNew));
}

/**
 * updateIRTState
 * Convenience wrapper: updates both difficulty_param and response_count.
 *
 * @param state    - Current IRTState for this question
 * @param mastery  - Current student mastery (0–100), used to derive θ
 * @param correct  - Whether the student answered correctly
 */
export function updateIRTState(
    state: IRTState,
    mastery: number,
    correct: boolean
): IRTState {
    const theta = masteryToTheta(mastery);
    const newB = updateDifficultyParam(
        state.difficulty_param,
        theta,
        correct,
        0.1,
        state.response_count
    );

    return {
        difficulty_param: Math.round(newB * 10000) / 10000,
        response_count: state.response_count + 1,
    };
}

/**
 * difficultyParamToLevel
 * Maps a calibrated b parameter back to the 1/2/3 difficulty level.
 * Used to keep the existing adaptive sampling system compatible.
 *
 *   b < −0.25  → easy   (1)
 *   b ∈ [−0.25, 0.25] → medium (2)
 *   b > +0.25  → hard   (3)
 */
export function difficultyParamToLevel(b: number): 1 | 2 | 3 {
    if (b < -0.25) return 1;
    if (b > 0.25) return 3;
    return 2;
}

/**
 * getInitialDifficultyParam
 * Returns the initial Rasch b value for a given LLM-assigned difficulty label.
 * Used when a question has no response history yet.
 */
export function getInitialDifficultyParam(difficultyLevel: number): number {
    const init: Record<number, number> = { 1: -0.5, 2: 0.0, 3: 0.5 };
    return init[difficultyLevel] ?? 0.0;
}