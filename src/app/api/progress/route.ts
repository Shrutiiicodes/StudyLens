import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase';

// 'complete' is the terminal stage — reached by passing the mastery test.
// Summary assessment has been removed; mastery test is the final gate.
const STAGES = ['diagnostic', 'practice', 'mastery', 'complete'] as const;
type Stage = typeof STAGES[number];

/**
 * GET /api/progress?userId=xxx&conceptId=xxx
 * Get the current stage and mastery for a concept.
 *
 * GET /api/progress?userId=xxx
 * Get all concept stages for a user.
 */
export async function GET(request: NextRequest) {
    try {
        const userId = request.nextUrl.searchParams.get('userId');
        const conceptId = request.nextUrl.searchParams.get('conceptId');
        const supabase = getServiceSupabase();

        if (!userId) {
            return NextResponse.json({ error: 'userId is required' }, { status: 400 });
        }

        if (conceptId) {
            const { data: mastery } = await supabase
                .from('mastery')
                .select('mastery_score, current_stage, last_updated')
                .eq('user_id', userId)
                .eq('concept_id', conceptId)
                .single();

            const currentStage = (mastery?.current_stage || 'diagnostic') as Stage;
            const stageIndex = STAGES.indexOf(currentStage);
            const isComplete = currentStage === 'complete';

            return NextResponse.json({
                success: true,
                conceptId,
                currentStage,
                stageIndex,
                isComplete,
                masteryScore: mastery?.mastery_score || 0,
                lastUpdated: mastery?.last_updated || null,
                // Show 3 actionable stages; 'complete' is a status not a stage button
                stages: (['diagnostic', 'practice', 'mastery'] as const).map((stage, idx) => ({
                    name: stage,
                    status: isComplete || idx < stageIndex
                        ? 'completed'
                        : idx === stageIndex
                            ? 'current'
                            : 'locked',
                })),
            });
        } else {
            const { data: masteryRecords } = await supabase
                .from('mastery')
                .select('concept_id, mastery_score, current_stage, last_updated')
                .eq('user_id', userId);

            const progressMap: Record<string, {
                score: number;
                stage: string;
                isComplete: boolean;
                lastUpdated: string;
            }> = {};

            for (const m of masteryRecords || []) {
                progressMap[m.concept_id] = {
                    score: m.mastery_score,
                    stage: m.current_stage || 'diagnostic',
                    isComplete: m.current_stage === 'complete',
                    lastUpdated: m.last_updated,
                };
            }

            return NextResponse.json({
                success: true,
                progress: progressMap,
            });
        }
    } catch (error) {
        console.error('Progress API error:', error);
        return NextResponse.json({
            success: true,
            currentStage: 'diagnostic',
            stageIndex: 0,
            isComplete: false,
            masteryScore: 0,
            stages: (['diagnostic', 'practice', 'mastery'] as const).map((s, i) => ({
                name: s,
                status: i === 0 ? 'current' : 'locked',
            })),
        });
    }
}