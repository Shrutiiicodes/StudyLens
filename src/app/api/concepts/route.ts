import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { calculateDecayedMastery } from '@/lib/forgetting-model';

/**
 * GET /api/concepts?userId=xxx
 * Get all concepts for a user from Supabase, with decayed mastery scores.
 */
export async function GET(request: NextRequest) {
    try {
        const userId = request.nextUrl.searchParams.get('userId');

        if (!userId) {
            return NextResponse.json({ error: 'userId is required' }, { status: 400 });
        }

        // Fetch concepts
        const { data: concepts, error } = await supabase
            .from('concepts')
            .select('id, title, source_document, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Concepts fetch error:', error);
            return NextResponse.json({ error: 'Failed to fetch concepts' }, { status: 500 });
        }

        if (!concepts || concepts.length === 0) {
            return NextResponse.json({ success: true, concepts: [] });
        }

        // Fetch mastery records for all these concepts in one query
        const conceptIds = concepts.map(c => c.id);
        const { data: masteryRecords } = await supabase
            .from('mastery')
            .select('concept_id, mastery_score, current_stage, last_updated')
            .eq('user_id', userId)
            .in('concept_id', conceptIds);

        // Build a lookup map: conceptId -> mastery record
        const masteryMap = new Map(
            (masteryRecords || []).map(m => [m.concept_id, m])
        );

        // Merge mastery into concepts, applying forgetting model decay
        const conceptsWithMastery = concepts.map(concept => {
            const mastery = masteryMap.get(concept.id);

            if (!mastery) {
                return {
                    ...concept,
                    mastery_score: 0,
                    current_stage: 'diagnostic',
                    last_updated: null,
                };
            }

            const hoursElapsed = mastery.last_updated
                ? (Date.now() - new Date(mastery.last_updated).getTime()) / (1000 * 60 * 60)
                : 0;

            const decayedScore = calculateDecayedMastery(
                mastery.mastery_score,
                hoursElapsed
            );

            return {
                ...concept,
                mastery_score: decayedScore,
                current_stage: mastery.current_stage || 'diagnostic',
                last_updated: mastery.last_updated,
            };
        });

        return NextResponse.json({
            success: true,
            concepts: conceptsWithMastery,
        });
    } catch (error) {
        console.error('Concepts API error:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}