/**
 * Evaluation Engine
 *
 * Orchestrates the full assessment flow:
 * 1. Evaluate answer
 * 2. Calculate score based on mode
 * 3. Update mastery
 * 4. Store attempt
 * 5. * Compute and persist all evaluation metrics (FAS, WBS, CCMS, MSS, LIP, RCI, calibration)
 */

import { getServiceSupabase } from './supabase';

const supabase = {
    from: (...args: Parameters<ReturnType<typeof getServiceSupabase>['from']>) =>
        getServiceSupabase().from(...args),
};

import {
    calculateUnifiedScore,
    spacedReinforcementScore,
    updateMastery,
    sampleDifficulty,
    calculateSAI,
} from './personalization-engine';
import { calculateDecayedMastery } from './forgetting-model';
import {
    computeAllSessionMetrics,
    computeConvergenceRate,
    inferCognitiveLevel,
    type AttemptResult,
} from './eval-metrics';
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

    await storeAttempt(userId, question, submission, correct);

    const currentMastery = await getCurrentMastery(userId, question.concept_id);

    const score = calculateUnifiedScore([questionResult]);

    const masteryUpdate = updateMastery(currentMastery, score, mode);
    await saveMastery(userId, question.concept_id, masteryUpdate.new_score);

    return {
        correct,
        explanation: question.explanation,
        mastery_delta: masteryUpdate.delta,
        new_mastery: masteryUpdate.new_score,
    };
}

const STAGES = ['diagnostic', 'practice', 'mastery'] as const;
const PASS_THRESHOLD = 60;

/**
 * Evaluate a full assessment session.
 * Handles all modes and now persists all Group-3 metrics.
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
    metrics: ReturnType<typeof computeAllSessionMetrics>;
}> {
    // ── 1. Compute raw score ──────────────────────────────────────────────
    const score = calculateUnifiedScore(results) * 100;

    // ── 2. Compute all Group-3 eval metrics ───────────────────────────────
    const attemptResults: AttemptResult[] = results.map((r) => ({
        correct: r.correct,
        confidence: r.confidence,
        time_taken: r.time_taken,
        question_type: 'recall', // fallback; enriched below if possible
        cognitive_level: r.cognitive_level ?? inferCognitiveLevel('recall'),
        difficulty: r.difficulty,
    }));

    const sessionMetrics = computeAllSessionMetrics(attemptResults, score);

    // ── 3. Mastery update ─────────────────────────────────────────────────
    const currentMastery = await getCurrentMastery(userId, conceptId);
    const masteryUpdate = updateMastery(currentMastery, score / 100, mode as AssessmentMode);

    const passed = score >= PASS_THRESHOLD;

    // ── 4. Create session record with metrics ─────────────────────────────
    const { data: sessionData, error: sessionError } = await supabase
        .from('sessions')
        .insert({
            user_id: userId,
            concept_id: conceptId,
            mode,
            score: Math.round(score),
            passed,
            // * Persist all eval metrics
            fas: Math.round(sessionMetrics.fas * 10000) / 10000,
            wbs: Math.round(sessionMetrics.wbs * 10000) / 10000,
            ccms: Math.round(sessionMetrics.ccms * 10000) / 10000,
            mss: Math.round(sessionMetrics.mss * 10000) / 10000,
            lip: Math.round(sessionMetrics.lip * 10000) / 10000,
            calibration_error: Math.round(sessionMetrics.calibration_error * 10000) / 10000,
            rci_avg: Math.round(sessionMetrics.rci_avg * 10000) / 10000,
        })
        .select()
        .single();

    if (sessionError) {
        console.error('Failed to create session:', sessionError);
    }

    const sessionId = sessionData?.id;

    // ── 5. Determine next stage ───────────────────────────────────────────
    const { data: masteryRecord } = await supabase
        .from('mastery')
        .select('current_stage')
        .eq('user_id', userId)
        .eq('concept_id', conceptId)
        .single();

    const currentStage = masteryRecord?.current_stage || 'diagnostic';
    const currentStageIndex = STAGES.indexOf(currentStage as (typeof STAGES)[number]);
    const modeIndex = STAGES.indexOf(mode as (typeof STAGES)[number]);

    let nextStage = currentStage;
    if (passed && modeIndex >= 0 && modeIndex <= currentStageIndex + 1) {
        const nextIndex = Math.min(modeIndex + 1, STAGES.length - 1);
        nextStage = STAGES[nextIndex];
    }

    // ── 6. Save mastery with updated stage ────────────────────────────────
    await saveMasteryWithStage(userId, conceptId, masteryUpdate.new_score, nextStage);

    // ── 7. Persist each attempt with session_id and mode ─────────────────
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

    // ── 8. Compute convergence and persist to session ─────────────────────
    const { data: allSessionScores } = await supabase
        .from('sessions')
        .select('score')
        .eq('user_id', userId)
        .eq('concept_id', conceptId)
        .order('created_at', { ascending: true });

    const scoreHistory = (allSessionScores ?? []).map((s) => s.score ?? 0);
    const convergenceRate = computeConvergenceRate(scoreHistory);

    if (sessionId) {
        await supabase
            .from('sessions')
            .update({ convergence_rate: convergenceRate })
            .eq('id', sessionId);
    }

    return {
        initialMastery: score,
        recommendedPath: score >= PASS_THRESHOLD ? 'test_it' : 'learn_it',
        masteryUpdate,
        nextStage,
        passed,
        metrics: sessionMetrics,
    };
}

export function getNextDifficulty(mastery: number): 1 | 2 | 3 {
    return sampleDifficulty(mastery);
}

export async function calculateStudentSAI(userId: string): Promise<number> {
    const { data: masteryRecords } = await supabase
        .from('mastery')
        .select('mastery_score')
        .eq('user_id', userId);

    if (!masteryRecords || masteryRecords.length === 0) return 0;

    const scores = masteryRecords.map((r) => r.mastery_score);
    const avgMastery = scores.reduce((a, b) => a + b, 0) / scores.length;

    const { data: attempts } = await supabase
        .from('attempts')
        .select('correct')
        .eq('user_id', userId);

    const totalAttempts = attempts?.length || 0;
    const correctAttempts = attempts?.filter((a) => a.correct).length || 0;
    const globalAccuracy = totalAttempts > 0 ? correctAttempts / totalAttempts : 0;

    const { data: confAttempts } = await supabase
        .from('attempts')
        .select('correct, confidence')
        .eq('user_id', userId);

    const avgCalibration =
        confAttempts && confAttempts.length > 0
            ? confAttempts.reduce((sum, a) => {
                const cc = 1 - Math.abs((a.correct ? 1 : 0) - (a.confidence || 0.5));
                return sum + cc;
            }, 0) / confAttempts.length
            : 0.5;

    const sai = calculateSAI(avgMastery, scores, globalAccuracy, avgCalibration);
    return sai.sai;
}

// ─── Helper Functions ─────────────────────────────────────────────────────────

async function getCurrentMastery(userId: string, conceptId: string): Promise<number> {
    const { data } = await supabase
        .from('mastery')
        .select('mastery_score, last_updated')
        .eq('user_id', userId)
        .eq('concept_id', conceptId)
        .single();

    if (!data) return 0;

    const hoursElapsed =
        (Date.now() - new Date(data.last_updated).getTime()) / (1000 * 60 * 60);
    return calculateDecayedMastery(data.mastery_score, hoursElapsed);
}

async function getLastMasteryUpdate(
    userId: string,
    conceptId: string
): Promise<string | null> {
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
            .update({ mastery_score: score, last_updated: new Date().toISOString() })
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

async function saveMasteryWithStage(
    userId: string,
    conceptId: string,
    score: number,
    stage: string
): Promise<void> {
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