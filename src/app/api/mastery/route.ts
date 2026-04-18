import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { calculateStudentSAI } from '@/lib/evaluation-engine';
import {
    getForgettingState,
    needsSpacedReinforcement,
    calculateOptimalReviewTime,
    getReviewUrgency,
} from '@/lib/forgetting-model';
import { getDifficultyDistribution } from '@/lib/personalization-engine';

/**
 * GET /api/mastery?userId=xxx
 * Get mastery overview for dashboard.
 *
 * CHANGE LOG (improvements batch):
 * - Added `review_by_date` (ISO string): absolute date by which the
 *   student should review the concept before mastery decays below 70.
 *   Already calculable via calculateOptimalReviewTime() — just wasn't wired.
 * - Added `review_urgency` (0–1): how urgently the review is needed.
 * - Added `review_days_remaining` (number): human-readable days left.
 * - Added `optimal_review_time_days` (number): raw days from model.
 * - Fixed: mss and learnItPriority were hardcoded to 0 — now computed
 *   from attempt data.
 */
export async function GET(request: NextRequest) {
    try {
        const userId = request.nextUrl.searchParams.get('userId');

        if (!userId) {
            return NextResponse.json({ error: 'userId is required' }, { status: 400 });
        }

        // Get all mastery records
        const { data: masteryRecords, error: masteryError } = await supabase
            .from('mastery')
            .select(`
        id,
        concept_id,
        mastery_score,
        last_updated,
        concepts (title)
      `)
            .eq('user_id', userId);

        if (masteryError) {
            return NextResponse.json({ error: 'Failed to fetch mastery data' }, { status: 500 });
        }

        // Fetch all attempts for MSS computation
        const { data: allAttempts } = await supabase
            .from('attempts')
            .select('concept_id, correct, confidence')
            .eq('user_id', userId);

        // Build per-concept MSS from attempts
        //   MSS = weighted sum of confident-wrong answers (see constants.ts MSS_WEIGHTS)
        //   High confidence (>0.7) + wrong  → weight 2.0
        //   Medium confidence (0.4–0.7) + wrong → weight 1.5
        //   Low confidence (<0.4) + wrong   → weight 1.0
        const mssMap: Record<string, { total: number; weighted: number }> = {};
        for (const a of allAttempts || []) {
            if (!mssMap[a.concept_id]) mssMap[a.concept_id] = { total: 0, weighted: 0 };
            mssMap[a.concept_id].total += 1;
            if (!a.correct) {
                const conf = a.confidence ?? 0.5;
                const weight = conf > 0.7 ? 2.0 : conf >= 0.4 ? 1.5 : 1.0;
                mssMap[a.concept_id].weighted += weight;
            }
        }

        const now = new Date();

        // Apply forgetting model to each concept
        const conceptMastery = (masteryRecords || []).map((record) => {
            const forgettingState = getForgettingState(
                record.mastery_score,
                record.last_updated
            );
            const needsReview = needsSpacedReinforcement(
                record.mastery_score,
                record.last_updated
            );
            const diffDist = getDifficultyDistribution(forgettingState.decayed_mastery);

            // ── Compute MSS for this concept ──
            const mssData = mssMap[record.concept_id];
            const mss = mssData && mssData.total > 0
                ? Math.min(2, mssData.weighted / mssData.total)
                : 0;

            // ── Compute Learn-It Priority ──
            // LIP = 0.5 * (1 - CCMS_proxy) + 0.5 * MSS_normalised
            const ccmsProxy = forgettingState.decayed_mastery / 100; // 0–1
            const mssNorm = mss / 2; // normalise 0–2 → 0–1
            const learnItPriority = Math.round((0.5 * (1 - ccmsProxy) + 0.5 * mssNorm) * 100) / 100;

            // ── Compute optimal review deadline ──
            // calculateOptimalReviewTime() returns days from NOW until mastery
            // decays to 70.  We add that to last_updated to get an absolute date.
            const optimalDays = calculateOptimalReviewTime(
                record.mastery_score, // use raw (not decayed) as baseline
                70
            );
            const lastUpdatedMs = new Date(record.last_updated).getTime();
            const reviewByMs = lastUpdatedMs + optimalDays * 24 * 60 * 60 * 1000;
            const reviewByDate = new Date(reviewByMs).toISOString();
            const reviewDaysRemaining = Math.max(
                0,
                Math.round((reviewByMs - now.getTime()) / (1000 * 60 * 60 * 24))
            );

            const reviewUrgency = getReviewUrgency(
                record.mastery_score,
                record.last_updated
            );

            return {
                concept_id: record.concept_id,
                concept_title:
                    (record.concepts as unknown as { title: string })?.title || 'Unknown',
                original_mastery: record.mastery_score,
                current_mastery: forgettingState.decayed_mastery,
                hours_since_update: forgettingState.hours_elapsed,
                needs_review: needsReview,
                difficulty_distribution: diffDist,
                last_updated: record.last_updated,
                mss,
                learn_it_priority: learnItPriority,
                // ── NEW fields ──
                review_by_date: reviewByDate,
                review_days_remaining: reviewDaysRemaining,
                review_urgency: Math.round(reviewUrgency * 100) / 100,
                optimal_review_time_days: Math.round(optimalDays * 10) / 10,
            };
        });

        // Get attempt statistics (global)
        const { data: attempts } = await supabase
            .from('attempts')
            .select('correct, difficulty, cognitive_level, confidence')
            .eq('user_id', userId);

        const totalAttempts = attempts?.length || 0;
        const correctAttempts = attempts?.filter((a) => a.correct).length || 0;
        const overallAccuracy =
            totalAttempts > 0 ? correctAttempts / totalAttempts : 0;

        // Calculate SAI
        let sai = 0;
        try {
            sai = await calculateStudentSAI(userId);
        } catch (e) {
            console.error('SAI calculation error:', e);
        }

        // Average mastery
        const avgMastery =
            conceptMastery.length > 0
                ? conceptMastery.reduce((sum, c) => sum + c.current_mastery, 0) /
                conceptMastery.length
                : 0;

        // Concepts due for review today (review_days_remaining === 0)
        const dueForReview = conceptMastery
            .filter((c) => c.review_days_remaining === 0 || c.needs_review)
            .sort((a, b) => b.review_urgency - a.review_urgency);

        return NextResponse.json({
            success: true,
            overview: {
                conceptCount: conceptMastery.length,
                averageMastery: Math.round(avgMastery),
                overallAccuracy: Math.round(overallAccuracy * 100),
                totalAttempts,
                sai,
                // ── NEW ──
                reviewDueCount: dueForReview.length,
            },
            concepts: conceptMastery,
            // ── NEW: pre-sorted list for the "Review Today" dashboard widget ──
            reviewQueue: dueForReview.map((c) => ({
                concept_id: c.concept_id,
                concept_title: c.concept_title,
                current_mastery: c.current_mastery,
                review_urgency: c.review_urgency,
                review_by_date: c.review_by_date,
            })),
        });
    } catch (error) {
        console.error('Mastery error:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}