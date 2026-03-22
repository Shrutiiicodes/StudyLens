import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { calculateStudentSAI, calculateMSS, calculateLearnItPriority } from '@/lib/evaluation-engine';
import { getForgettingState, needsSpacedReinforcement } from '@/lib/forgetting-model';
import { getDifficultyDistribution } from '@/lib/personalization-engine';

/**
 * GET /api/mastery?userId=xxx
 * Get mastery overview for dashboard.
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

        // Apply forgetting model to each concept
        const conceptMastery = await Promise.all(
            (masteryRecords || []).map(async (record) => {
                const forgettingState = getForgettingState(
                    record.mastery_score,
                    record.last_updated
                );
                const needsReview = needsSpacedReinforcement(
                    record.mastery_score,
                    record.last_updated
                );
                const diffDist = getDifficultyDistribution(forgettingState.decayed_mastery);

                // Calculate MSS for this concept
                let mss = 0;
                try {
                    mss = await calculateMSS(userId, record.concept_id);
                } catch (e) {
                    console.warn('[Mastery] MSS calculation failed for concept:', record.concept_id);
                }

                // Calculate Learn It priority
                const learnItPriority = calculateLearnItPriority(
                    forgettingState.decayed_mastery,
                    mss
                );

                return {
                    concept_id: record.concept_id,
                    concept_title: (record.concepts as unknown as { title: string })?.title || 'Unknown',
                    original_mastery: record.mastery_score,
                    current_mastery: forgettingState.decayed_mastery,
                    hours_since_update: forgettingState.hours_elapsed,
                    needs_review: needsReview,
                    difficulty_distribution: diffDist,
                    last_updated: record.last_updated,
                    mss,
                    learn_it_priority: learnItPriority,
                };
            })
        );

        // Get attempt statistics
        const { data: attempts } = await supabase
            .from('attempts')
            .select('correct, difficulty, cognitive_level, confidence')
            .eq('user_id', userId);

        const totalAttempts = attempts?.length || 0;
        const correctAttempts = attempts?.filter((a) => a.correct).length || 0;
        const overallAccuracy = totalAttempts > 0 ? correctAttempts / totalAttempts : 0;

        // Calculate SAI
        let sai = 0;
        try {
            sai = await calculateStudentSAI(userId);
        } catch (e) {
            console.error('SAI calculation error:', e);
        }

        // Average mastery
        const avgMastery = conceptMastery.length > 0
            ? conceptMastery.reduce((sum, c) => sum + c.current_mastery, 0) / conceptMastery.length
            : 0;

        return NextResponse.json({
            success: true,
            overview: {
                conceptCount: conceptMastery.length,
                averageMastery: Math.round(avgMastery),
                overallAccuracy: Math.round(overallAccuracy * 100),
                totalAttempts,
                sai,
            },
            concepts: conceptMastery,
        });
    } catch (error) {
        console.error('Mastery error:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}
