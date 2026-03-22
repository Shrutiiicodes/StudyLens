import { DifficultyDistribution } from '@/types/mastery';
import { DifficultyLevel } from '@/types/question';

/**
 * Difficulty Distribution Engine
 * 
 * Calculates the probability distribution of Easy/Medium/Hard questions
 * based on the student's current mastery score.
 * 
 * E(M) = max(0, 0.7 - 0.006M)
 * Med(M) = 0.3 + 0.002M
 * H(M) = 1 - (E + Med)
 */
export function getDifficultyDistribution(mastery: number): DifficultyDistribution {
    const m = Math.max(0, Math.min(100, mastery));

    const easy = Math.max(0, 0.7 - 0.006 * m);
    const medium = 0.3 + 0.002 * m;
    const hard = Math.max(0, 1 - (easy + medium));

    // Normalize to ensure they sum to 1
    const total = easy + medium + hard;

    return {
        easy: easy / total,
        medium: medium / total,
        hard: hard / total,
    };
}

/**
 * Sample next question difficulty probabilistically
 * based on the mastery-adjusted distribution.
 */
export function sampleDifficulty(mastery: number): DifficultyLevel {
    const dist = getDifficultyDistribution(mastery);
    const rand = Math.random();

    if (rand < dist.easy) return 1;
    if (rand < dist.easy + dist.medium) return 2;
    return 3;
}

/**
 * Get the expected time for a question at a given difficulty level.
 */
export function getExpectedTime(difficulty: DifficultyLevel): number {
    const times: Record<DifficultyLevel, number> = {
        1: 30,
        2: 60,
        3: 90,
    };
    return times[difficulty];
}

/**
 * Determine if a concept should be unlocked, locked, or mastered.
 */
export function getConceptStatus(mastery: number): 'locked' | 'unlocked' | 'mastered' {
    if (mastery >= 85) return 'mastered';
    if (mastery >= 70) return 'unlocked';
    return 'locked';
}
