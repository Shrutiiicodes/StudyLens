/**
 * Evaluation Engine
 *
 * Orchestrates the full assessment flow:
 * 1. Evaluate answer
 * 2. Calculate score based on mode
 * 3. Update mastery
 * 4. Store attempt
 * 5. Compute and persist all metrics
 * 6. Run KG-grounded misconception analysis (with LLM fallback)
 */

import { getServiceSupabase } from './supabase';
const supabase = {
    from: (...args: Parameters<ReturnType<typeof getServiceSupabase>['from']>) =>
        getServiceSupabase().from(...args),
};

import {
    calculateUnifiedScore,
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
import { Question, AnswerSubmission, AnswerResult, QuestionType } from '@/types/question';
import { updateIRTState, getInitialDifficultyParam, masteryToTheta } from './irt';
import { analyzeAnswer } from './distractor-engine';

/**
 * Evaluate a student's answer and update mastery.
 * Now includes KG-grounded misconception analysis.
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
        question_type: question.type,
    };

    const currentMastery = await getCurrentMastery(userId, question.concept_id);
    await storeAttempt(userId, question, submission, correct, currentMastery);

    const score = calculateUnifiedScore([questionResult]);
    const masteryUpdate = updateMastery(currentMastery, score, mode);
    await saveMastery(userId, question.concept_id, masteryUpdate.new_score);

    // ── KG-grounded misconception analysis ───────────────────────────────
    // Primary: deterministic graph-topology scoring
    // Fallback: LLM-only if graph unavailable (handled inside analyzeAnswer)
    let misconceptionData: AnswerResult['misconception'];

    try {
        const analysis = await analyzeAnswer({
            questionText: question.text,
            correctAnswer: question.correct_answer,
            studentAnswer: submission.selected_answer,
            qType: question.options?.length === 4 ? 'mcq' : 'short',
            concept: question.concept_title || '',
            relation: '',
            distanceMap: question.distractor_distances,
            userId,
            documentId: question.concept_id,
            sourceText: '',
        });

        if (!analysis.isCorrect) {
            misconceptionData = {
                severity: analysis.severity,
                misconceptionLabel: analysis.misconceptionLabel,
                gapDescription: analysis.gapDescription,
                correctExplanation: analysis.correctExplanation,
                hint: analysis.hint,
                kgPath: analysis.kgPath,
            };
        }
    } catch (e) {
        // Non-fatal — misconception analysis is an enhancement, not core flow
        console.warn('[Eval] Misconception analysis failed (non-fatal):', (e as Error).message);
    }

    return {
        correct,
        explanation: misconceptionData?.gapDescription
            ? `${question.explanation}\n\n💡 ${misconceptionData.gapDescription}`
            : question.explanation,
        mastery_delta: masteryUpdate.delta,
        new_mastery: masteryUpdate.new_score,
        misconception: misconceptionData,
    };
}

const STAGES = ['diagnostic', 'practice', 'mastery'] as const;
// Mastery learning threshold: 80% per Bloom (1984) mastery learning criteria.
const PASS_THRESHOLD = 80;

/**
 * Evaluate a full assessment session.
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

    // ── 2. Fetch pre-session mastery ──────────────────────────────────────
    const preMastery = await getCurrentMastery(userId, conceptId);

    // ── 3. Load fitted BKT params ─────────────────────────────────────────
    const { data: fittedParams } = await supabase
        .from('concept_bkt_params')
        .select('p_l0, p_t, p_s, p_g')
        .eq('concept_id', conceptId)
        .single();

    const bktParams = fittedParams
        ? { p_l0: fittedParams.p_l0, p_t: fittedParams.p_t, p_s: fittedParams.p_s, p_g: fittedParams.p_g }
        : undefined;

    // ── 4. Mastery update ─────────────────────────────────────────────────
    const masteryUpdate = updateMastery(preMastery, score / 100, mode as AssessmentMode, results, bktParams);
    const postMastery = masteryUpdate.new_score;
    const passed = score >= PASS_THRESHOLD;

    // ── 5. Build AttemptResult array ──────────────────────────────────────
    const attemptResults: AttemptResult[] = results.map((r) => ({
        correct: r.correct,
        confidence: r.confidence,
        time_taken: r.time_taken,
        question_type: 'recall',
        cognitive_level: r.cognitive_level ?? inferCognitiveLevel('recall'),
        difficulty: r.difficulty,
    }));

    // ── 6. Compute all metrics ────────────────────────────────────────────
    const sessionMetrics = computeAllSessionMetrics(
        attemptResults,
        score,
        preMastery,
        postMastery,
    );

    // ── 7. Create session record ──────────────────────────────────────────
    const { data: sessionData, error: sessionError } = await supabase
        .from('sessions')
        .insert({
            user_id: userId,
            concept_id: conceptId,
            mode,
            score: Math.round(score),
            passed,
            fas: round4(sessionMetrics.fas),
            wbs: round4(sessionMetrics.wbs),
            ccms: round4(sessionMetrics.ccms),
            mss: round4(sessionMetrics.mss),
            lip: round4(sessionMetrics.lip),
            calibration_error: round4(sessionMetrics.calibration_error),
            rci_avg: round4(sessionMetrics.rci_avg),
            nlg: round4((sessionMetrics as any).nlg ?? 0),
            brier_score: round4((sessionMetrics as any).brier_score ?? 0),
            ece: round4((sessionMetrics as any).ece ?? 0),
            log_loss: round4((sessionMetrics as any).log_loss ?? 0),
        })
        .select()
        .single();

    if (sessionError) {
        if (sessionError.code === '23503') {
            console.warn('Skipping session persistence: user is a Demo account not present in Supabase Auth.');
        } else {
            console.error('Failed to create session:', sessionError);
        }
    }

    const sessionId = sessionData?.id;

    // ── 8. Determine next stage ───────────────────────────────────────────
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
        if (mode === 'mastery') {
            nextStage = 'complete';
        } else {
            const nextIndex = Math.min(modeIndex + 1, STAGES.length - 1);
            nextStage = STAGES[nextIndex];
        }
    }

    // ── 9. Save mastery with updated stage ────────────────────────────────
    await saveMasteryWithStage(userId, conceptId, postMastery, nextStage);

    // ── 10. Auto-trigger BKT fitting if ready ────────────────────────────
    autoFitBKTIfReady(userId, conceptId).catch(e =>
        console.warn('[BKT] Auto-fit skipped:', e.message)
    );

    // ── 11. Persist each attempt ──────────────────────────────────────────
    for (const result of results) {
        await supabase.from('attempts').insert({
            user_id: userId,
            concept_id: result.concept_id || conceptId,
            question_id: result.question_id,
            correct: result.correct,
            difficulty: result.difficulty,
            cognitive_level: result.cognitive_level,
            question_type: result.question_type ?? 'recall',
            time_taken: result.time_taken,
            confidence: result.confidence,
            mode: mode === 'spaced' ? 'practice' : mode,
            is_spaced_review: mode === 'spaced' || (result.concept_id != null && result.concept_id !== conceptId),
            session_id: sessionId,
        });
    }

    // ── 12. Compute convergence and persist ───────────────────────────────
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
    correct: boolean,
    currentMastery: number = 50
): Promise<void> {
    const { data: irtRow } = await supabase
        .from('question_irt')
        .select('difficulty_param, response_count')
        .eq('question_id', question.id)
        .single();

    const currentIRT = irtRow ?? {
        difficulty_param: getInitialDifficultyParam(question.difficulty),
        response_count: 0,
    };

    const theta = masteryToTheta(currentMastery);

    await supabase.from('attempts').insert({
        user_id: userId,
        concept_id: question.concept_id,
        question_id: question.id,
        correct,
        difficulty: question.difficulty,
        cognitive_level: question.cognitive_level,
        question_type: question.type ?? 'recall',
        time_taken: submission.time_taken,
        confidence: submission.confidence,
        difficulty_param: round4(currentIRT.difficulty_param),
        student_theta: round4(theta),
    });

    const updatedIRT = updateIRTState(currentIRT, currentMastery, correct);
    await supabase
        .from('question_irt')
        .upsert({
            question_id: question.id,
            difficulty_param: updatedIRT.difficulty_param,
            response_count: updatedIRT.response_count,
            last_updated: new Date().toISOString(),
        }, { onConflict: 'question_id' });
}

function round4(n: number): number {
    return Math.round(n * 10000) / 10000;
}

async function autoFitBKTIfReady(userId: string, conceptId: string): Promise<void> {
    const { count } = await supabase
        .from('attempts')
        .select('*', { count: 'exact', head: true })
        .eq('concept_id', conceptId);

    if (!count || count < 30) return;

    const { data: existing } = await supabase
        .from('concept_bkt_params')
        .select('fitted_at')
        .eq('concept_id', conceptId)
        .single();

    if (existing?.fitted_at) {
        const hoursSinceFit = (Date.now() - new Date(existing.fitted_at).getTime()) / (1000 * 60 * 60);
        if (hoursSinceFit < 24) return;
    }

    const { data: attempts } = await supabase
        .from('attempts')
        .select('user_id, correct, created_at')
        .eq('concept_id', conceptId)
        .order('created_at', { ascending: true });

    if (!attempts || attempts.length < 30) return;

    const studentSequences: Record<string, boolean[]> = {};
    for (const a of attempts) {
        if (!studentSequences[a.user_id]) studentSequences[a.user_id] = [];
        studentSequences[a.user_id].push(a.correct);
    }
    const sequences = Object.values(studentSequences).filter(s => s.length >= 2);
    if (sequences.length < 3) return;

    const STEP = 0.05;
    let bestLL = -Infinity;
    let bestParams = { p_l0: 0.25, p_t: 0.12, p_s: 0.08, p_g: 0.25 };

    const range = (lo: number, hi: number): number[] => {
        const arr: number[] = [];
        for (let v = lo; v <= hi + 1e-9; v += STEP) arr.push(Math.round(v * 100) / 100);
        return arr;
    };

    const computeLL = (params: typeof bestParams): number => {
        let total = 0;
        for (const seq of sequences) {
            let pKnows = params.p_l0;
            for (const correct of seq) {
                const pObs = correct
                    ? pKnows * (1 - params.p_s) + (1 - pKnows) * params.p_g
                    : pKnows * params.p_s + (1 - pKnows) * (1 - params.p_g);
                total += Math.log(Math.max(1e-10, pObs));
                pKnows = correct
                    ? (pKnows * (1 - params.p_s)) / Math.max(1e-10, pObs)
                    : (pKnows * params.p_s) / Math.max(1e-10, pObs);
                pKnows = pKnows + (1 - pKnows) * params.p_t;
            }
        }
        return total;
    };

    for (const p_l0 of range(0.05, 0.50)) {
        for (const p_t of range(0.05, 0.40)) {
            for (const p_s of range(0.02, 0.35)) {
                for (const p_g of range(0.10, 0.35)) {
                    if (p_s + p_g >= 1.0) continue;
                    const params = { p_l0, p_t, p_s, p_g };
                    const ll = computeLL(params);
                    if (ll > bestLL) { bestLL = ll; bestParams = { ...params }; }
                }
            }
        }
    }

    await supabase.from('concept_bkt_params').upsert({
        concept_id: conceptId,
        p_l0: bestParams.p_l0,
        p_t: bestParams.p_t,
        p_s: bestParams.p_s,
        p_g: bestParams.p_g,
        log_likelihood: Math.round(bestLL * 1000) / 1000,
        n_sequences: sequences.length,
        n_attempts: attempts.length,
        fitted_at: new Date().toISOString(),
    }, { onConflict: 'concept_id' });

    console.log(`[BKT] Auto-fitted concept ${conceptId}: p_l0=${bestParams.p_l0} p_t=${bestParams.p_t} p_s=${bestParams.p_s} p_g=${bestParams.p_g}`);
}