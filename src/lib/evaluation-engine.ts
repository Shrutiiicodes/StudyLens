/**
 * Evaluation Engine — Enhanced with IPD misconception enrichment
 *
 * Orchestrates the full assessment flow:
 * 1. Evaluate answer
 * 2. Calculate score based on mode
 * 3. Update mastery
 * 4. Store attempt
 * 5. (NEW) Enrich with KG-grounded misconception analysis from IPD backend
 */

import { getServiceSupabase } from './supabase';

const supabase = {
    from: (...args: Parameters<ReturnType<typeof getServiceSupabase>['from']>) =>
        getServiceSupabase().from(...args),
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

// ─── Stages ────────────────────────────────────────────────────────────────

const STAGES = ['diagnostic', 'practice', 'mastery', 'spaced', 'summary'] as const;
const PASS_THRESHOLD = 60;

// ─── Per-question evaluation ────────────────────────────────────────────────

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

    const masteryUpdate = updateMastery(currentMastery, score, mode);
    await saveMastery(userId, question.concept_id, masteryUpdate.new_score);

    return {
        correct,
        explanation: question.explanation,
        mastery_delta: masteryUpdate.delta,
        new_mastery: masteryUpdate.new_score,
    };
}

// ─── Full session evaluation ────────────────────────────────────────────────

export async function evaluateDiagnostic(
    userId: string,
    conceptId: string,
    results: QuestionResult[],
    mode: string = 'diagnostic',
    // Optional: raw student answers for misconception enrichment
    rawAnswers?: Array<{
        question_id: string;
        student_answer: string;
        chosen_option?: string;
    }>
): Promise<{
    initialMastery: number;
    recommendedPath: 'test_it' | 'learn_it';
    masteryUpdate: MasteryUpdate;
    nextStage: string;
    passed: boolean;
    misconceptionReport?: import('@/lib/backend-client').MisconceptionReport | null;
}> {
    // ── 1. Score the session ──────────────────────────────────────────────
    let score: number;
    switch (mode) {
        case 'practice':
            score = practiceScore(results) * 100;
            break;
        case 'mastery':
            score = masteryScore(results) * 100;
            break;
        case 'spaced': {
            const avg =
                results.reduce((sum, r) => sum + spacedReinforcementScore(r, 0), 0) /
                results.length;
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
    const passed = score >= PASS_THRESHOLD;

    // ── 2. Create a session record ────────────────────────────────────────
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

    // ── 3. Determine next stage ───────────────────────────────────────────
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

    await saveMasteryWithStage(userId, conceptId, masteryUpdate.new_score, nextStage);

    // ── 4. Store individual attempts ──────────────────────────────────────
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

    // ── 5. IPD misconception enrichment (non-fatal) ───────────────────────
    let misconceptionReport:
        | import('@/lib/backend-client').MisconceptionReport
        | null = null;

    try {
        const { getMisconceptionReport } = await import('@/lib/backend-client');

        // Look up the doc_id from our pipeline_runs table
        const { data: pipelineRun } = await supabase
            .from('pipeline_runs')
            .select('doc_id')
            .eq('concept_id', conceptId)
            .eq('status', 'completed')
            .order('started_at', { ascending: false })
            .limit(1)
            .single();

        if (pipelineRun?.doc_id && rawAnswers && rawAnswers.length > 0) {
            misconceptionReport = await getMisconceptionReport(
                pipelineRun.doc_id,
                userId,
                rawAnswers
            );

            if (misconceptionReport?.breakdown) {
                const criticalGaps = misconceptionReport.breakdown
                    .filter((item) => item.severity === 'CRITICAL')
                    .map((item) => item.misconception_label)
                    .filter(Boolean);

                // Update session with misconception summary
                if (sessionId) {
                    await supabase
                        .from('sessions')
                        .update({
                            misconception_count: misconceptionReport.breakdown.filter(
                                (item) => !item.is_correct
                            ).length,
                            critical_gaps: criticalGaps,
                        })
                        .eq('id', sessionId);
                }

                // Insert each misconception record
                for (const item of misconceptionReport.breakdown) {
                    if (!item.is_correct) {
                        await supabase.from('misconceptions').insert({
                            user_id: userId,
                            concept_id: conceptId,
                            session_id: sessionId,
                            question_text: item.question,
                            correct_answer: item.correct_answer,
                            student_answer: item.student_answer,
                            is_correct: item.is_correct,
                            score: item.score,
                            severity: item.severity,
                            misconception_label: item.misconception_label,
                            gap_description: item.gap_description,
                            correct_explanation: item.correct_explanation,
                            hint: item.hint,
                            kg_path: item.kg_path ?? [],
                            checks: item.checks ?? {},
                            distractor_distance: item.distractor_distance ?? null,
                        });
                    }
                }

                console.log(
                    `[Eval] Misconception enrichment complete — ` +
                    `${misconceptionReport.breakdown.length} items, ` +
                    `critical gaps: ${criticalGaps.length}`
                );
            }
        }
    } catch (e) {
        console.warn('[Eval] Misconception enrichment failed (non-fatal):', e);
    }

    return {
        initialMastery: score,
        recommendedPath: score >= PASS_THRESHOLD ? 'test_it' : 'learn_it',
        masteryUpdate,
        nextStage,
        passed,
        misconceptionReport,
    };
}

// ─── Next difficulty ────────────────────────────────────────────────────────

export function getNextDifficulty(mastery: number): 1 | 2 | 3 {
    return sampleDifficulty(mastery);
}

// ─── SAI ────────────────────────────────────────────────────────────────────

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

// ─── Helpers ────────────────────────────────────────────────────────────────

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

async function saveMastery(
    userId: string,
    conceptId: string,
    score: number
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