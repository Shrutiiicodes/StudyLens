import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase';
import {
    computeMasteryImprovementRate,
    computeAvgTimeToMastery,
    computeCCMSImprovement,
    computeCalibrationError,
    computeConvergenceRate,
    computeSAI,
    computeAUCROC,
    type AttemptResult,
} from '@/lib/eval-metrics';

/**
 * GET /api/metrics?userId=xxx
 * Returns all computed metrics for a student's dashboard.
 * Now surfaces NLG, Brier Score, ECE, and Log-Loss as primary ITS metrics.
 *
 * GET /api/metrics?userId=xxx&conceptId=xxx
 * Returns metrics scoped to a single concept.
 *
 * GET /api/metrics?system=true
 * Returns system-level aggregate metrics (admin only).
 */
export async function GET(request: NextRequest) {
    try {
        const supabase = getServiceSupabase();
        const { searchParams } = new URL(request.url);
        const userId = searchParams.get('userId');
        const conceptId = searchParams.get('conceptId');
        const systemLevel = searchParams.get('system') === 'true';

        // ── System-level metrics ──────────────────────────────────────────
        if (systemLevel) {
            const { data: allMastery } = await supabase
                .from('mastery')
                .select('mastery_score, user_id');

            const finalScores = (allMastery ?? []).map((m) => m.mastery_score);
            const masteryImprovementRate = computeMasteryImprovementRate(finalScores);

            const { data: sessionCounts } = await supabase
                .from('sessions')
                .select('user_id')
                .not('passed', 'is', null);

            const userSessionMap: Record<string, number> = {};
            for (const s of sessionCounts ?? []) {
                userSessionMap[s.user_id] = (userSessionMap[s.user_id] ?? 0) + 1;
            }
            const avgTTM = computeAvgTimeToMastery(Object.values(userSessionMap));

            // CCMS with vs without LearnIt
            const { data: sessionsWithCCMS } = await supabase
                .from('sessions')
                .select('ccms, mode')
                .not('ccms', 'is', null);

            const withLearnIt = (sessionsWithCCMS ?? [])
                .filter((s) => s.mode === 'practice' && s.ccms != null)
                .map((s) => s.ccms as number);
            const withoutLearnIt = (sessionsWithCCMS ?? [])
                .filter((s) => s.mode === 'diagnostic' && s.ccms != null)
                .map((s) => s.ccms as number);
            const ccmsComparison = computeCCMSImprovement(withLearnIt, withoutLearnIt);

            // System-level NLG: average NLG across all sessions with valid nlg values
            const { data: allSessionsNLG } = await supabase
                .from('sessions')
                .select('nlg, brier_score, ece')
                .not('nlg', 'is', null);

            const nlgValues = (allSessionsNLG ?? []).map((s) => s.nlg as number);
            const brierValues = (allSessionsNLG ?? [])
                .filter((s) => s.brier_score != null)
                .map((s) => s.brier_score as number);
            const eceValues = (allSessionsNLG ?? [])
                .filter((s) => s.ece != null)
                .map((s) => s.ece as number);

            const avg = (arr: number[]) =>
                arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

            return NextResponse.json({
                success: true,
                system: {
                    total_students: new Set((allMastery ?? []).map((m) => m.user_id)).size,
                    mastery_improvement_rate: Math.round(masteryImprovementRate * 100),
                    avg_time_to_mastery_sessions: Math.round(avgTTM * 10) / 10,
                    // Legacy
                    ccms_with_learnit: Math.round(ccmsComparison.withLearnIt * 100) / 100,
                    ccms_without_learnit: Math.round(ccmsComparison.withoutLearnIt * 100) / 100,
                    ccms_improvement_delta: Math.round(ccmsComparison.delta * 100) / 100,
                    // Standard ITS
                    avg_nlg: avg(nlgValues) !== null ? Math.round(avg(nlgValues as number[])! * 1000) / 1000 : null,
                    avg_brier_score: avg(brierValues) !== null ? Math.round(avg(brierValues)! * 1000) / 1000 : null,
                    avg_ece: avg(eceValues) !== null ? Math.round(avg(eceValues)! * 1000) / 1000 : null,
                },
            });
        }

        if (!userId) {
            return NextResponse.json({ error: 'userId is required' }, { status: 400 });
        }

        // ── Student-level metrics ─────────────────────────────────────────

        let attemptsQuery = supabase
            .from('attempts')
            .select('correct, confidence, time_taken, difficulty, cognitive_level, mode, created_at, concept_id')
            .eq('user_id', userId)
            .order('created_at', { ascending: true });

        if (conceptId) attemptsQuery = attemptsQuery.eq('concept_id', conceptId);

        const { data: attempts } = await attemptsQuery;

        // Fetch sessions — now including standard ITS metric columns
        let sessionsQuery = supabase
            .from('sessions')
            .select('id, concept_id, mode, score, passed, fas, wbs, ccms, mss, lip, calibration_error, nlg, brier_score, ece, log_loss, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: true });

        if (conceptId) sessionsQuery = sessionsQuery.eq('concept_id', conceptId);

        const { data: sessions } = await sessionsQuery;

        let masteryQuery = supabase
            .from('mastery')
            .select('mastery_score, concept_id, last_updated')
            .eq('user_id', userId);

        if (conceptId) masteryQuery = masteryQuery.eq('concept_id', conceptId);

        const { data: masteryRecords } = await masteryQuery;

        // ── Compute student metrics ───────────────────────────────────────

        const allAttempts = attempts ?? [];
        const totalAttempts = allAttempts.length;
        const correctAttempts = allAttempts.filter((a) => a.correct).length;
        const globalAccuracy = totalAttempts > 0 ? correctAttempts / totalAttempts : 0;

        const attemptResults: AttemptResult[] = allAttempts.map((a) => ({
            correct: a.correct,
            confidence: a.confidence ?? 0.5,
            time_taken: a.time_taken ?? 0,
            question_type: a.mode ?? 'recall',
            cognitive_level: a.cognitive_level ?? 1,
            difficulty: a.difficulty ?? 1,
        }));

        const calibrationError = computeCalibrationError(attemptResults);

        const masteryScores = (masteryRecords ?? []).map((m) => m.mastery_score);
        const avgMastery =
            masteryScores.length > 0
                ? masteryScores.reduce((a, b) => a + b, 0) / masteryScores.length
                : 0;

        const sessionScores = (sessions ?? []).map((s) => s.score ?? 0);
        const convergenceRate = computeConvergenceRate(sessionScores);

        const avgCalibration = 1 - calibrationError;
        const sai = computeSAI(avgMastery, sessionScores, globalAccuracy, avgCalibration);

        const latestSession = (sessions ?? []).slice(-1)[0];

        // ── Standard ITS metric aggregates ────────────────────────────────
        // Average NLG across all sessions that have it (skip nulls from old sessions)
        const nlgValues = (sessions ?? [])
            .filter((s) => s.nlg != null)
            .map((s) => s.nlg as number);
        const avgNLG = nlgValues.length > 0
            ? nlgValues.reduce((a, b) => a + b, 0) / nlgValues.length
            : null;

        // Latest NLG — most recent session's learning gain
        const latestNLG = (sessions ?? [])
            .filter((s) => s.nlg != null)
            .slice(-1)[0]?.nlg ?? null;

        const brierValues = (sessions ?? [])
            .filter((s) => s.brier_score != null)
            .map((s) => s.brier_score as number);
        const avgBrierScore = brierValues.length > 0
            ? brierValues.reduce((a, b) => a + b, 0) / brierValues.length
            : null;

        const eceValues = (sessions ?? [])
            .filter((s) => s.ece != null)
            .map((s) => s.ece as number);
        const avgECE = eceValues.length > 0
            ? eceValues.reduce((a, b) => a + b, 0) / eceValues.length
            : null;

        const logLossValues = (sessions ?? [])
            .filter((s) => s.log_loss != null)
            .map((s) => s.log_loss as number);
        const avgLogLoss = logLossValues.length > 0
            ? logLossValues.reduce((a, b) => a + b, 0) / logLossValues.length
            : null;

        // NLG trend: last 5 sessions with NLG (for sparkline chart)
        const nlgHistory = (sessions ?? [])
            .filter((s) => s.nlg != null)
            .slice(-5)
            .map((s) => ({ nlg: s.nlg as number, score: s.score, mode: s.mode, created_at: s.created_at }));

        // ── Per-concept breakdown ─────────────────────────────────────────
        const conceptBreakdown: Record<
            string,
            {
                sessions: number;
                avgScore: number;
                passed: number;
                latestCCMS: number | null;
                latestNLG: number | null;
                avgBrier: number | null;
            }
        > = {};

        for (const s of sessions ?? []) {
            const cid = s.concept_id;
            if (!conceptBreakdown[cid]) {
                conceptBreakdown[cid] = {
                    sessions: 0, avgScore: 0, passed: 0,
                    latestCCMS: null, latestNLG: null, avgBrier: null,
                };
            }
            conceptBreakdown[cid].sessions += 1;
            conceptBreakdown[cid].avgScore += s.score ?? 0;
            if (s.passed) conceptBreakdown[cid].passed += 1;
            if (s.ccms != null) conceptBreakdown[cid].latestCCMS = s.ccms;
            if (s.nlg != null) conceptBreakdown[cid].latestNLG = s.nlg;
        }

        // Compute per-concept avgBrier from brier_score sessions
        for (const s of sessions ?? []) {
            if (s.brier_score == null) continue;
            const cid = s.concept_id;
            if (!conceptBreakdown[cid]) continue;
            // Accumulate then divide below
            conceptBreakdown[cid].avgBrier =
                (conceptBreakdown[cid].avgBrier ?? 0) + (s.brier_score as number);
        }

        for (const cid of Object.keys(conceptBreakdown)) {
            const entry = conceptBreakdown[cid];
            entry.avgScore = Math.round(entry.avgScore / entry.sessions);
            if (entry.avgBrier !== null) {
                const brierCount = (sessions ?? []).filter(
                    (s) => s.concept_id === cid && s.brier_score != null
                ).length;
                entry.avgBrier = brierCount > 0
                    ? Math.round((entry.avgBrier / brierCount) * 1000) / 1000
                    : null;
            }
        }

        return NextResponse.json({
            success: true,
            student: {
                // Overall
                total_attempts: totalAttempts,
                global_accuracy: Math.round(globalAccuracy * 100),
                avg_mastery: Math.round(avgMastery),
                sai,

                // Legacy calibration & convergence
                calibration_error: Math.round(calibrationError * 100) / 100,
                avg_calibration: Math.round(avgCalibration * 100) / 100,
                convergence_rate: convergenceRate,

                // ── Standard ITS metrics (primary display metrics) ──
                its_metrics: {
                    // AUC-ROC — computed across all attempts (Piech et al., 2015)
                    auc_roc: (() => {
                        const pairs = allAttempts.map(a => ({ confidence: a.confidence ?? 0.5, correct: a.correct }));
                        const auc = computeAUCROC(pairs);
                        return pairs.length >= 10 ? auc : null; // only report if enough data
                    })(),
                    // NLG — Learning Gain (Hake, 1998)
                    avg_nlg: avgNLG !== null ? Math.round(avgNLG * 1000) / 1000 : null,
                    latest_nlg: latestNLG !== null ? Math.round(latestNLG * 1000) / 1000 : null,
                    nlg_history: nlgHistory,

                    // Brier Score — calibration quality (lower = better)
                    avg_brier_score: avgBrierScore !== null ? Math.round(avgBrierScore * 1000) / 1000 : null,

                    // ECE — Expected Calibration Error (lower = better)
                    avg_ece: avgECE !== null ? Math.round(avgECE * 1000) / 1000 : null,

                    // Log-Loss — prediction quality proxy for AUC-ROC (lower = better)
                    avg_log_loss: avgLogLoss !== null ? Math.round(avgLogLoss * 1000) / 1000 : null,
                },

                // Latest session — now includes standard ITS metrics
                latest_session: latestSession
                    ? {
                        // Legacy
                        fas: latestSession.fas,
                        wbs: latestSession.wbs,
                        ccms: latestSession.ccms,
                        mss: latestSession.mss,
                        lip: latestSession.lip,
                        calibration_error: latestSession.calibration_error,
                        // Standard ITS
                        nlg: latestSession.nlg,
                        brier_score: latestSession.brier_score,
                        ece: latestSession.ece,
                        log_loss: latestSession.log_loss,
                        mode: latestSession.mode,
                        score: latestSession.score,
                    }
                    : null,

                // History for charts
                session_score_history: sessionScores,
                total_sessions: (sessions ?? []).length,
                total_passed: (sessions ?? []).filter((s) => s.passed).length,

                // Per-concept (now includes NLG + Brier per concept)
                concept_breakdown: conceptBreakdown,
            },
        });
    } catch (error) {
        console.error('Metrics API error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}