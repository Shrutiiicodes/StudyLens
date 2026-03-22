/**
 * Evaluation Engine
 * 
 * Orchestrates the full assessment flow:
 * 1. Evaluate answer
 * 2. Calculate score based on mode
 * 3. Update mastery
 * 4. Store attempt
 */

import { getServiceSupabase } from './supabase';

const supabase = {
    from: (...args: Parameters<ReturnType<typeof getServiceSupabase>['from']>) => getServiceSupabase().from(...args),
};
import {
    calculateInitialMastery,
    practiceScore,
    masteryScore,
    spacedReinforcementScore,
    updateMastery,
    sampleDifficulty,
    calculateSAI,
} from './personalization-engine';
import { calculateDecayedMastery } from './forgetting-model';
import { AssessmentMode } from '@/types/student';
import { QuestionResult, MasteryUpdate } from '@/types/mastery';
import { Question, AnswerSubmission, AnswerResult } from '@/types/question';
import { EXPECTED_TIME } from '@/config/constants';

/**
 * Evaluate a student's answer and update mastery.
 */
export async function evaluateAnswer(
    userId: string,
    question: Question,
    submission: AnswerSubmission,
    mode: AssessmentMode
): Promise<AnswerResult> {
    const correct = submission.selected_answer === question.correct_answer;

    const questionResult: QuestionResult = {
        question_id: question.id,
        correct,
        difficulty: question.difficulty,
        cognitive_level: question.cognitive_level,
        time_taken: submission.time_taken,
        confidence: submission.confidence,
    };

    // Store the attempt
    await storeAttempt(userId, question, submission, correct);

    // Get current mastery
    const currentMastery = await getCurrentMastery(userId, question.concept_id);

    // Calculate score based on mode
    let score: number;
    switch (mode) {
        case 'diagnostic':
            score = calculateInitialMastery([questionResult]) / 100;
            break;
        case 'practice':
            score = practiceScore([questionResult]);
            break;
        case 'mastery':
            score = masteryScore([questionResult]);
            break;
        case 'spaced': {
            const lastUpdated = await getLastMasteryUpdate(userId, question.concept_id);
            const hoursElapsed = lastUpdated
                ? (Date.now() - new Date(lastUpdated).getTime()) / (1000 * 60 * 60)
                : 0;
            score = spacedReinforcementScore(questionResult, hoursElapsed);
            break;
        }
        default:
            score = practiceScore([questionResult]);
    }

    // Update mastery
    const masteryUpdate = updateMastery(currentMastery, score, mode);
    await saveMastery(userId, question.concept_id, masteryUpdate.new_score);

    return {
        correct,
        explanation: question.explanation,
        mastery_delta: masteryUpdate.delta,
        new_mastery: masteryUpdate.new_score,
    };
}

/**
 * Stages in order of progression.
 */
const STAGES = ['diagnostic', 'practice', 'mastery', 'spaced', 'summary'] as const;
const PASS_THRESHOLD = 60; // Score >= 60% to advance

/**
 * Evaluate a full assessment session.
 * Handles all modes: diagnostic, practice, mastery, spaced.
 */
export async function evaluateDiagnostic(
    userId: string,
    conceptId: string,
    results: QuestionResult[],
    mode: string = 'diagnostic'
): Promise<{
    initialMastery: number;
    recommendedPath: 'test_it' | 'learn_it';
    masteryUpdate: MasteryUpdate;
    nextStage: string;
    passed: boolean;
}> {
    // Calculate score based on mode
    let score: number;
    switch (mode) {
        case 'practice':
            score = practiceScore(results) * 100;
            break;
        case 'mastery':
            score = masteryScore(results) * 100;
            break;
        case 'spaced': {
            // Average spaced scores across all results
            const avg = results.reduce((sum, r) => sum + spacedReinforcementScore(r, 0), 0) / results.length;
            score = avg * 100;
            break;
        }
        case 'diagnostic':
        default:
            score = calculateInitialMastery(results);
            break;
    }

    const currentMastery = await getCurrentMastery(userId, conceptId);
    const masteryUpdate = updateMastery(currentMastery, score / 100, mode as AssessmentMode);

    // Determine if passed
    const passed = score >= PASS_THRESHOLD;

    // 1. Create a Session record
    const { data: sessionData, error: sessionError } = await supabase
        .from('sessions')
        .insert({
            user_id: userId,
            concept_id: conceptId,
            mode,
            score: Math.round(score),
            passed,
        })
        .select()
        .single();

    if (sessionError) {
        console.error('Failed to create session:', sessionError);
    }

    const sessionId = sessionData?.id;

    // Get current stage
    const { data: masteryRecord } = await supabase
        .from('mastery')
        .select('current_stage')
        .eq('user_id', userId)
        .eq('concept_id', conceptId)
        .single();

    const currentStage = masteryRecord?.current_stage || 'diagnostic';
    const currentStageIndex = STAGES.indexOf(currentStage as typeof STAGES[number]);
    const modeIndex = STAGES.indexOf(mode as typeof STAGES[number]);

    // Advance stage if passed and this was the current stage
    let nextStage = currentStage;
    if (passed && modeIndex >= 0 && modeIndex <= currentStageIndex + 1) {
        const nextIndex = Math.min(modeIndex + 1, STAGES.length - 1);
        nextStage = STAGES[nextIndex];
    }

    // Save mastery with stage
    await saveMasteryWithStage(userId, conceptId, masteryUpdate.new_score, nextStage);

    // Store each attempt with mode and link to sessionId
    for (const result of results) {
        await supabase.from('attempts').insert({
            user_id: userId,
            concept_id: conceptId,
            question_id: result.question_id,
            correct: result.correct,
            difficulty: result.difficulty,
            cognitive_level: result.cognitive_level,
            time_taken: result.time_taken,
            confidence: result.confidence,
            mode,
            session_id: sessionId,
        });
    }

    return {
        initialMastery: score,
        recommendedPath: score >= PASS_THRESHOLD ? 'test_it' : 'learn_it',
        masteryUpdate,
        nextStage,
        passed,
    };
}

/**
 * Get next question difficulty based on current mastery.
 */
export function getNextDifficulty(mastery: number): 1 | 2 | 3 {
    return sampleDifficulty(mastery);
}

/**
 * Calculate SAI for a student.
 */
export async function calculateStudentSAI(userId: string): Promise<number> {
    // Get all mastery records
    const { data: masteryRecords } = await supabase
        .from('mastery')
        .select('mastery_score')
        .eq('user_id', userId);

    if (!masteryRecords || masteryRecords.length === 0) return 0;

    const scores = masteryRecords.map((r) => r.mastery_score);
    const avgMastery = scores.reduce((a, b) => a + b, 0) / scores.length;

    // Get accuracy from attempts
    const { data: attempts } = await supabase
        .from('attempts')
        .select('correct')
        .eq('user_id', userId);

    const totalAttempts = attempts?.length || 0;
    const correctAttempts = attempts?.filter((a) => a.correct).length || 0;
    const globalAccuracy = totalAttempts > 0 ? correctAttempts / totalAttempts : 0;

    // Get confidence calibration
    const { data: confAttempts } = await supabase
        .from('attempts')
        .select('correct, confidence')
        .eq('user_id', userId);

    const avgCalibration = confAttempts && confAttempts.length > 0
        ? confAttempts.reduce((sum, a) => {
            const cc = 1 - Math.abs((a.correct ? 1 : 0) - (a.confidence || 0.5));
            return sum + cc;
        }, 0) / confAttempts.length
        : 0.5;

    const sai = calculateSAI(avgMastery, scores, globalAccuracy, avgCalibration);
    return sai.sai;
}

// ─── Helper Functions ───

async function getCurrentMastery(userId: string, conceptId: string): Promise<number> {
    const { data } = await supabase
        .from('mastery')
        .select('mastery_score, last_updated')
        .eq('user_id', userId)
        .eq('concept_id', conceptId)
        .single();

    if (!data) return 0;

    // Apply forgetting model
    const hoursElapsed = (Date.now() - new Date(data.last_updated).getTime()) / (1000 * 60 * 60);
    return calculateDecayedMastery(data.mastery_score, hoursElapsed);
}

async function getLastMasteryUpdate(userId: string, conceptId: string): Promise<string | null> {
    const { data } = await supabase
        .from('mastery')
        .select('last_updated')
        .eq('user_id', userId)
        .eq('concept_id', conceptId)
        .single();

    return data?.last_updated || null;
}

async function saveMastery(userId: string, conceptId: string, score: number): Promise<void> {
    const { data: existing } = await supabase
        .from('mastery')
        .select('id')
        .eq('user_id', userId)
        .eq('concept_id', conceptId)
        .single();

    if (existing) {
        await supabase
            .from('mastery')
            .update({
                mastery_score: score,
                last_updated: new Date().toISOString(),
            })
            .eq('id', existing.id);
    } else {
        await supabase.from('mastery').insert({
            user_id: userId,
            concept_id: conceptId,
            mastery_score: score,
            last_updated: new Date().toISOString(),
        });
    }
}

async function saveMasteryWithStage(userId: string, conceptId: string, score: number, stage: string): Promise<void> {
    const { data: existing } = await supabase
        .from('mastery')
        .select('id')
        .eq('user_id', userId)
        .eq('concept_id', conceptId)
        .single();

    if (existing) {
        await supabase
            .from('mastery')
            .update({
                mastery_score: score,
                current_stage: stage,
                last_updated: new Date().toISOString(),
            })
            .eq('id', existing.id);
    } else {
        await supabase.from('mastery').insert({
            user_id: userId,
            concept_id: conceptId,
            mastery_score: score,
            current_stage: stage,
            last_updated: new Date().toISOString(),
        });
    }
}

async function storeAttempt(
    userId: string,
    question: Question,
    submission: AnswerSubmission,
    correct: boolean
): Promise<void> {
    await supabase.from('attempts').insert({
        user_id: userId,
        concept_id: question.concept_id,
        question_id: question.id,
        correct,
        difficulty: question.difficulty,
        cognitive_level: question.cognitive_level,
        time_taken: submission.time_taken,
        confidence: submission.confidence,
    });
}
