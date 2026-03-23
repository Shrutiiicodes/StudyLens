import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase';
import {
    computeMasteryImprovementRate,
    computeAvgTimeToMastery,
    computeCCMSImprovement,
    computeCalibrationError,
    computeConvergenceRate,
    computeSAI,
    type AttemptResult,
} from '@/lib/eval-metrics';

/**
 * GET /api/metrics?userId=xxx
 * Returns all computed metrics for a student's dashboard.
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

            // Sessions per user (proxy for time-to-mastery)
            const { data: sessionCounts } = await supabase
                .from('sessions')
                .select('user_id')
                .not('passed', 'is', null);

            const userSessionMap: Record<string, number> = {};
            for (const s of sessionCounts ?? []) {
                userSessionMap[s.user_id] = (userSessionMap[s.user_id] ?? 0) + 1;
            }
            const avgTTM = computeAvgTimeToMastery(Object.values(userSessionMap));

            // CCMS with vs without LearnIt (approximated via learn page visits)
            const { data: sessionsWithCCMS } = await supabase
                .from('sessions')
                .select('ccms, mode')
                .not('ccms', 'is', null);

            // Proxy: "learn_it" mode sessions = used LearnIt before re-attempting
            const withLearnIt = (sessionsWithCCMS ?? [])
                .filter((s) => s.mode === 'practice' && s.ccms != null)
                .map((s) => s.ccms as number);
            const withoutLearnIt = (sessionsWithCCMS ?? [])
                .filter((s) => s.mode === 'diagnostic' && s.ccms != null)
                .map((s) => s.ccms as number);

            const ccmsComparison = computeCCMSImprovement(withLearnIt, withoutLearnIt);

            return NextResponse.json({
                success: true,
                system: {
                    total_students: new Set((allMastery ?? []).map((m) => m.user_id)).size,
                    mastery_improvement_rate: Math.round(masteryImprovementRate * 100),
                    avg_time_to_mastery_sessions: Math.round(avgTTM * 10) / 10,
                    ccms_with_learnit: Math.round(ccmsComparison.withLearnIt * 100) / 100,
                    ccms_without_learnit: Math.round(ccmsComparison.withoutLearnIt * 100) / 100,
                    ccms_improvement_delta: Math.round(ccmsComparison.delta * 100) / 100,
                },
            });
        }

        if (!userId) {
            return NextResponse.json({ error: 'userId is required' }, { status: 400 });
        }

        // ── Student-level metrics ─────────────────────────────────────────

        // Fetch all attempts for this user (optionally filtered by concept)
        let attemptsQuery = supabase
            .from('attempts')
            .select('correct, confidence, time_taken, difficulty, cognitive_level, mode, created_at, concept_id')
            .eq('user_id', userId)
            .order('created_at', { ascending: true });

        if (conceptId) {
            attemptsQuery = attemptsQuery.eq('concept_id', conceptId);
        }

        const { data: attempts } = await attemptsQuery;

        // Fetch sessions for this user
        let sessionsQuery = supabase
            .from('sessions')
            .select('id, concept_id, mode, score, passed, fas, wbs, ccms, mss, lip, calibration_error, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: true });

        if (conceptId) {
            sessionsQuery = sessionsQuery.eq('concept_id', conceptId);
        }

        const { data: sessions } = await sessionsQuery;

        // Fetch mastery history
        let masteryQuery = supabase
            .from('mastery')
            .select('mastery_score, concept_id, last_updated')
            .eq('user_id', userId);

        if (conceptId) {
            masteryQuery = masteryQuery.eq('concept_id', conceptId);
        }

        const { data: masteryRecords } = await masteryQuery;

        // ── Compute student metrics ──

        const allAttempts = attempts ?? [];
        const totalAttempts = allAttempts.length;
        const correctAttempts = allAttempts.filter((a) => a.correct).length;
        const globalAccuracy = totalAttempts > 0 ? correctAttempts / totalAttempts : 0;

        // Build AttemptResult array for metric functions
        const attemptResults: AttemptResult[] = allAttempts.map((a) => ({
            correct: a.correct,
            confidence: a.confidence ?? 0.5,
            time_taken: a.time_taken ?? 0,
            question_type: a.mode ?? 'recall',
            cognitive_level: a.cognitive_level ?? 1,
            difficulty: a.difficulty ?? 1,
        }));

        const calibrationError = computeCalibrationError(attemptResults);

        // Mastery history for convergence + SAI
        const masteryScores = (masteryRecords ?? []).map((m) => m.mastery_score);
        const avgMastery =
            masteryScores.length > 0
                ? masteryScores.reduce((a, b) => a + b, 0) / masteryScores.length
                : 0;

        // For convergence: use the per-session scores as a proxy history
        const sessionScores = (sessions ?? []).map((s) => s.score ?? 0);
        const convergenceRate = computeConvergenceRate(sessionScores);

        const avgCalibration = 1 - calibrationError; // Flip: higher = better
        const sai = computeSAI(avgMastery, sessionScores, globalAccuracy, avgCalibration);

        // Latest session metrics (for display)
        const latestSession = (sessions ?? []).slice(-1)[0];

        // Per-concept breakdown
        const conceptBreakdown: Record<
            string,
            { sessions: number; avgScore: number; passed: number; latestCCMS: number | null }
        > = {};

        for (const s of sessions ?? []) {
            const cid = s.concept_id;
            if (!conceptBreakdown[cid]) {
                conceptBreakdown[cid] = { sessions: 0, avgScore: 0, passed: 0, latestCCMS: null };
            }
            conceptBreakdown[cid].sessions += 1;
            conceptBreakdown[cid].avgScore += s.score ?? 0;
            if (s.passed) conceptBreakdown[cid].passed += 1;
            if (s.ccms != null) conceptBreakdown[cid].latestCCMS = s.ccms;
        }

        for (const cid of Object.keys(conceptBreakdown)) {
            const entry = conceptBreakdown[cid];
            entry.avgScore = Math.round(entry.avgScore / entry.sessions);
        }

        return NextResponse.json({
            success: true,
            student: {
                // Overall
                total_attempts: totalAttempts,
                global_accuracy: Math.round(globalAccuracy * 100),
                avg_mastery: Math.round(avgMastery),
                sai,

                // Calibration & convergence
                calibration_error: Math.round(calibrationError * 100) / 100,
                avg_calibration: Math.round(avgCalibration * 100) / 100,
                convergence_rate: convergenceRate,

                // Latest session
                latest_session: latestSession
                    ? {
                        fas: latestSession.fas,
                        wbs: latestSession.wbs,
                        ccms: latestSession.ccms,
                        mss: latestSession.mss,
                        lip: latestSession.lip,
                        calibration_error: latestSession.calibration_error,
                        mode: latestSession.mode,
                        score: latestSession.score,
                    }
                    : null,

                // History for charts
                session_score_history: sessionScores,
                total_sessions: (sessions ?? []).length,
                total_passed: (sessions ?? []).filter((s) => s.passed).length,

                // Per-concept
                concept_breakdown: conceptBreakdown,
            },
        });
    } catch (error) {
        console.error('Metrics API error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}