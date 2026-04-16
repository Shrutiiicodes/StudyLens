import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase';
import { raschProbability, masteryToTheta, difficultyParamToLevel } from '@/lib/irt';

/**
 * GET /api/irt?questionId=xxx
 * Returns the current calibrated Rasch difficulty parameter for a single question.
 *
 * GET /api/irt?conceptId=xxx
 * Returns IRT calibration state for all questions belonging to a concept.
 *
 * GET /api/irt?conceptId=xxx&userId=xxx
 * Returns IRT state enriched with P(correct) for this student's current mastery,
 * useful for adaptive question selection.
 *
 * GET /api/irt?system=true
 * Returns system-wide IRT summary: distribution of difficulty params,
 * most/least calibrated questions, coverage stats.
 */
export async function GET(request: NextRequest) {
    try {
        const supabase = getServiceSupabase();
        const { searchParams } = new URL(request.url);

        const questionId = searchParams.get('questionId');
        const conceptId = searchParams.get('conceptId');
        const userId = searchParams.get('userId');
        const systemMode = searchParams.get('system') === 'true';

        // ── System-wide IRT summary ───────────────────────────────────────
        if (systemMode) {
            const { data: allIRT, error } = await supabase
                .from('question_irt')
                .select('question_id, difficulty_param, response_count, last_updated')
                .order('response_count', { ascending: false });

            if (error) {
                return NextResponse.json({ error: 'Failed to fetch IRT data' }, { status: 500 });
            }

            const rows = allIRT ?? [];
            const totalQuestions = rows.length;
            const calibrated = rows.filter(r => r.response_count >= 10).length;
            const uncalibrated = rows.filter(r => r.response_count < 5).length;

            // Distribution across difficulty bands
            const bands = { easy: 0, medium: 0, hard: 0 };
            for (const r of rows) {
                const level = difficultyParamToLevel(r.difficulty_param);
                if (level === 1) bands.easy++;
                else if (level === 2) bands.medium++;
                else bands.hard++;
            }

            // Average b per band
            const avgParam = rows.length > 0
                ? rows.reduce((s, r) => s + r.difficulty_param, 0) / rows.length
                : 0;

            // Most-responded (most reliable) questions
            const topCalibrated = rows.slice(0, 5).map(r => ({
                question_id: r.question_id,
                difficulty_param: r.difficulty_param,
                difficulty_level: difficultyParamToLevel(r.difficulty_param),
                response_count: r.response_count,
                last_updated: r.last_updated,
            }));

            // Least-responded (least reliable)
            const leastCalibrated = [...rows]
                .sort((a, b) => a.response_count - b.response_count)
                .slice(0, 5)
                .map(r => ({
                    question_id: r.question_id,
                    difficulty_param: r.difficulty_param,
                    difficulty_level: difficultyParamToLevel(r.difficulty_param),
                    response_count: r.response_count,
                }));

            return NextResponse.json({
                success: true,
                system: {
                    total_questions: totalQuestions,
                    calibrated_count: calibrated,   // ≥10 responses
                    uncalibrated_count: uncalibrated,  // <5 responses
                    calibration_pct: totalQuestions > 0
                        ? Math.round((calibrated / totalQuestions) * 100)
                        : 0,
                    avg_difficulty_param: Math.round(avgParam * 1000) / 1000,
                    difficulty_distribution: bands,
                    top_calibrated: topCalibrated,
                    least_calibrated: leastCalibrated,
                },
            });
        }

        // ── Single question ───────────────────────────────────────────────
        if (questionId) {
            const { data: irtRow, error } = await supabase
                .from('question_irt')
                .select('question_id, difficulty_param, response_count, last_updated')
                .eq('question_id', questionId)
                .single();

            if (error || !irtRow) {
                return NextResponse.json(
                    { error: `No IRT data found for question ${questionId}` },
                    { status: 404 }
                );
            }

            // If userId provided, compute P(correct) for this student
            let pCorrect: number | null = null;
            if (userId) {
                const { data: mastery } = await supabase
                    .from('mastery')
                    .select('mastery_score')
                    .eq('user_id', userId)
                    .single();

                if (mastery) {
                    const theta = masteryToTheta(mastery.mastery_score);
                    pCorrect = Math.round(
                        raschProbability(theta, irtRow.difficulty_param) * 1000
                    ) / 1000;
                }
            }

            return NextResponse.json({
                success: true,
                question: {
                    question_id: irtRow.question_id,
                    difficulty_param: irtRow.difficulty_param,
                    difficulty_level: difficultyParamToLevel(irtRow.difficulty_param),
                    response_count: irtRow.response_count,
                    calibrated: irtRow.response_count >= 10,
                    last_updated: irtRow.last_updated,
                    ...(pCorrect !== null && { p_correct_for_student: pCorrect }),
                },
            });
        }

        // ── All questions for a concept ───────────────────────────────────
        if (conceptId) {
            // Get all attempt question_ids for this concept to join with IRT
            const { data: attempts } = await supabase
                .from('attempts')
                .select('question_id')
                .eq('concept_id', conceptId);

            if (!attempts || attempts.length === 0) {
                return NextResponse.json({
                    success: true,
                    concept_id: conceptId,
                    questions: [],
                    summary: { total: 0, calibrated: 0, avg_difficulty_param: null },
                });
            }

            const questionIds = [...new Set(attempts.map(a => a.question_id).filter(Boolean))];

            const { data: irtRows, error } = await supabase
                .from('question_irt')
                .select('question_id, difficulty_param, response_count, last_updated')
                .in('question_id', questionIds)
                .order('difficulty_param', { ascending: true });

            if (error) {
                return NextResponse.json({ error: 'Failed to fetch IRT data' }, { status: 500 });
            }

            const rows = irtRows ?? [];

            // If userId provided, fetch mastery to compute P(correct) per question
            let theta: number | null = null;
            if (userId) {
                const { data: mastery } = await supabase
                    .from('mastery')
                    .select('mastery_score')
                    .eq('user_id', userId)
                    .eq('concept_id', conceptId)
                    .single();

                if (mastery) {
                    theta = masteryToTheta(mastery.mastery_score);
                }
            }

            const questions = rows.map(r => ({
                question_id: r.question_id,
                difficulty_param: r.difficulty_param,
                difficulty_level: difficultyParamToLevel(r.difficulty_param),
                response_count: r.response_count,
                calibrated: r.response_count >= 10,
                last_updated: r.last_updated,
                ...(theta !== null && {
                    p_correct_for_student: Math.round(
                        raschProbability(theta, r.difficulty_param) * 1000
                    ) / 1000,
                }),
            }));

            const avgParam = rows.length > 0
                ? rows.reduce((s, r) => s + r.difficulty_param, 0) / rows.length
                : null;

            const calibratedCount = rows.filter(r => r.response_count >= 10).length;

            // Drift check: how many questions have drifted >0.25 from their
            // original label's initialisation value (|b - b_init| > 0.25)
            // This is a useful research signal — large drift = LLM label was wrong
            const driftedCount = rows.filter(r => {
                const level = difficultyParamToLevel(r.difficulty_param);
                const initMap: Record<number, number> = { 1: -0.5, 2: 0.0, 3: 0.5 };
                return Math.abs(r.difficulty_param - initMap[level]) > 0.25;
            }).length;

            return NextResponse.json({
                success: true,
                concept_id: conceptId,
                questions,
                summary: {
                    total: rows.length,
                    calibrated: calibratedCount,
                    calibration_pct: rows.length > 0
                        ? Math.round((calibratedCount / rows.length) * 100)
                        : 0,
                    avg_difficulty_param: avgParam !== null
                        ? Math.round(avgParam * 1000) / 1000
                        : null,
                    drifted_from_label: driftedCount,
                    drift_pct: rows.length > 0
                        ? Math.round((driftedCount / rows.length) * 100)
                        : 0,
                    ...(theta !== null && { student_theta: Math.round(theta * 1000) / 1000 }),
                },
            });
        }

        return NextResponse.json(
            { error: 'Provide questionId, conceptId, or system=true' },
            { status: 400 }
        );

    } catch (error) {
        console.error('IRT API error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}