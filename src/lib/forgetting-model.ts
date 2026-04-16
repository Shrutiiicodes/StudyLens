/**
 * Forgetting Model
 * 
 * Implements the exponential decay model for mastery scores.
 * M_decayed = M * e^(-γΔt)
 * γ = 0.05 (decay rate)
 */

import { GAMMA_FORGETTING } from '@/config/constants';
import { ForgettingState } from '@/types/mastery';

export interface FSRSState {
    stability: number;
    difficulty: number;
}

export const DEFAULT_FSRS_STATE: FSRSState = {
    stability: 1.0,
    difficulty: 5.0,
};

/**
 * Calculate decayed mastery score. M_decayed = M × e^(−γ × days)
 * @param mastery - Current mastery score (0-100)
 * @param hoursElapsed - Hours since last assessment
 * @param gamma - Decay rate (default: 0.05)
 * @returns Decayed mastery score
 */

export function calculateDecayedMastery(
    mastery: number,
    hoursElapsed: number,
    gamma: number = GAMMA_FORGETTING
): number {
    if (hoursElapsed <= 0) return mastery;
    const days = hoursElapsed / 24;
    const decayed = mastery * Math.exp(-gamma * days);
    return Math.max(0, Math.round(decayed * 100) / 100);
}

/**
 * Get the full forgetting state for a concept.
 */
export function getForgettingState(
    mastery: number,
    lastUpdated: string,
    now?: Date
): ForgettingState {
    const currentTime = now || new Date();
    const lastTime = new Date(lastUpdated);
    const hoursElapsed = (currentTime.getTime() - lastTime.getTime()) / (1000 * 60 * 60);

    return {
        original_mastery: mastery,
        decayed_mastery: calculateDecayedMastery(mastery, hoursElapsed),
        hours_elapsed: hoursElapsed,
        gamma: GAMMA_FORGETTING,
    };
}

/**
 * Check if spaced reinforcement is needed.
 * Returns true if mastery has decayed below the lock threshold.
 */
export function needsSpacedReinforcement(
    mastery: number,
    lastUpdated: string,
    lockThreshold: number = 70
): boolean {
    const state = getForgettingState(mastery, lastUpdated);
    return state.decayed_mastery < lockThreshold;
}

/**
 * Calculate optimal review time.
 * Finds when mastery will decay to a given threshold.
 * 
 * threshold = M * e^(-γ*t)
 * t = -ln(threshold/M) / γ
 */
export function calculateOptimalReviewTime(
    mastery: number,
    threshold: number = 70,
    gamma: number = GAMMA_FORGETTING
): number {
    if (mastery <= threshold) return 0;
    if (mastery <= 0) return 0;

    // Returns time in days
    const days = -Math.log(threshold / mastery) / gamma;
    return Math.max(0, days);
}

/**
 * Get review urgency (0-1, where 1 is most urgent).
 */
export function getReviewUrgency(
    mastery: number,
    lastUpdated: string,
    lockThreshold: number = 70
): number {
    const state = getForgettingState(mastery, lastUpdated);

    if (state.decayed_mastery >= mastery * 0.9) return 0; // Barely decayed
    if (state.decayed_mastery <= lockThreshold) return 1; // Critical

    const range = mastery - lockThreshold;
    if (range <= 0) return 1;

    const decayAmount = mastery - state.decayed_mastery;
    return Math.min(1, decayAmount / range);
}
// ─── FSRS Model (Ye, 2022) ────────────────────────────────────────────────────

/**
 * fsrsRetrievability
 * R(t) = (1 + t / (9 × S))^(−1)
 *
 * R(t) is the probability of recall at time t (days since last review).
 * S = stability (number of days until R ≈ 90%).
 * Range: 0–1.
 *
 * Citation: Ye, J. (2022). A stochastic shortest path algorithm for
 *           optimizing spaced repetition scheduling. KDD 2022.
 */
export function fsrsRetrievability(daysSinceReview: number, stability: number): number {
    if (stability <= 0) return 0;
    if (daysSinceReview <= 0) return 1;
    return Math.pow(1 + daysSinceReview / (9 * stability), -1);
}

/**
 * updateFSRSStability
 * Updates stability S after a review attempt.
 *
 * If recalled correctly:
 *   S_new = S × (1 + e^(0.9) × (11 − D) × S^(−0.2) × (e^(1−R) − 1))
 *
 * If forgotten:
 *   S_new = max(0.5, S × 0.5)  [stability halved, minimum 0.5 days]
 *
 * @param stability      - Current stability S (days)
 * @param difficulty     - Card difficulty D (1–10, 5 = neutral)
 * @param retrievability - R(t) at time of review (0–1)
 * @param recalled       - Whether the student recalled correctly
 */
export function updateFSRSStability(
    stability: number,
    difficulty: number,
    retrievability: number,
    recalled: boolean
): number {
    if (!recalled) {
        return Math.max(0.5, stability * 0.5);
    }
    const factor = 1 + Math.exp(0.9) * (11 - difficulty) * Math.pow(stability, -0.2) * (Math.exp(1 - retrievability) - 1);
    return Math.max(0.5, stability * factor);
}

/**
 * updateFSRSDifficulty
 * Adjusts difficulty D based on performance.
 * Easy recall → D decreases slightly. Failure → D increases.
 *
 * @param difficulty - Current difficulty (1–10)
 * @param recalled   - Whether the student recalled correctly
 */
export function updateFSRSDifficulty(difficulty: number, recalled: boolean): number {
    const delta = recalled ? -0.15 : 0.3;
    return Math.max(1, Math.min(10, difficulty + delta));
}

/**
 * updateFSRSState
 * Full FSRS state update after a review.
 * Call this after every answered question in spaced reinforcement mode.
 *
 * @param state       - Current FSRS state {stability, difficulty}
 * @param daysSinceReview - Days elapsed since last review
 * @param recalled    - Whether the student recalled correctly
 * @returns Updated FSRSState
 */
export function updateFSRSState(
    state: FSRSState,
    daysSinceReview: number,
    recalled: boolean
): FSRSState {
    const r = fsrsRetrievability(daysSinceReview, state.stability);
    const newStability = updateFSRSStability(state.stability, state.difficulty, r, recalled);
    const newDifficulty = updateFSRSDifficulty(state.difficulty, recalled);

    return {
        stability: Math.round(newStability * 1000) / 1000,
        difficulty: Math.round(newDifficulty * 100) / 100,
    };
}

/**
 * calculateFSRSDecayedMastery
 * Uses FSRS retrievability to decay the mastery score.
 * More principled than the fixed-γ exponential model:
 * decay is personalised per student per concept via S and D.
 *
 * decayed_mastery = mastery × R(t)
 *
 * @param mastery         - Current mastery score (0–100)
 * @param hoursElapsed    - Hours since last review
 * @param fsrsState       - Student's FSRS state for this concept
 */
export function calculateFSRSDecayedMastery(
    mastery: number,
    hoursElapsed: number,
    fsrsState: FSRSState = DEFAULT_FSRS_STATE
): number {
    if (hoursElapsed <= 0) return mastery;
    const days = hoursElapsed / 24;
    const r = fsrsRetrievability(days, fsrsState.stability);
    const decayed = mastery * r;
    return Math.max(0, Math.round(decayed * 100) / 100);
}

/**
 * fsrsNextReviewDays
 * Returns the number of days until FSRS retrievability drops below a threshold.
 * Solve: threshold = (1 + t / (9S))^(−1) for t
 *   → t = 9S × (1/threshold − 1)
 *
 * @param fsrsState       - Current FSRS state
 * @param threshold       - Minimum acceptable retrievability (default: 0.70)
 */
export function fsrsNextReviewDays(
    fsrsState: FSRSState,
    threshold: number = 0.70
): number {
    if (threshold <= 0 || threshold >= 1) return 0;
    const days = 9 * fsrsState.stability * (1 / threshold - 1);
    return Math.max(0, Math.round(days * 10) / 10);
}