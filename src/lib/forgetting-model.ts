/**
 * Forgetting Model
 * 
 * Implements the exponential decay model for mastery scores.
 * M_decayed = M * e^(-γΔt)
 * γ = 0.05 (decay rate)
 */

import { GAMMA_FORGETTING } from '@/config/constants';
import { ForgettingState } from '@/types/mastery';

/**
 * Calculate decayed mastery score.
 * 
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

    // Convert hours to days for the decay calculation
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
