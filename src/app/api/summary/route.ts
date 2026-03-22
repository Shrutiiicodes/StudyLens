import { NextRequest, NextResponse } from 'next/server';
import { evaluateSummary, getConceptContext } from '@/lib/question-generator';
import { getServiceSupabase } from '@/lib/supabase';

/**
 * POST /api/summary
 * Evaluate a student's written summary of a concept.
 */
export async function POST(request: NextRequest) {
    try {
        const { userId, conceptId, conceptTitle, summary } = await request.json();

        if (!userId || !conceptId || !conceptTitle || !summary) {
            return NextResponse.json(
                { error: 'userId, conceptId, conceptTitle, and summary are required' },
                { status: 400 }
            );
        }

        if (summary.trim().length < 50) {
            return NextResponse.json(
                { error: 'Summary must be at least 50 characters long' },
                { status: 400 }
            );
        }

        // Get concept context for evaluation
        const context = await getConceptContext(conceptId);

        // Evaluate with LLM
        const result = await evaluateSummary(conceptTitle, context || conceptTitle, summary);

        const supabase = getServiceSupabase();

        // Store the summary attempt
        await supabase.from('attempts').insert({
            user_id: userId,
            concept_id: conceptId,
            question_id: `summary_${Date.now()}`,
            correct: result.score >= 60,
            difficulty: 3,
            cognitive_level: 5,
            time_taken: 0,
            confidence: 1,
            mode: 'summary',
        });

        // If passed, mark concept as complete
        if (result.score >= 60) {
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
                        current_stage: 'complete',
                        mastery_score: Math.max(result.score, 80),
                        last_updated: new Date().toISOString(),
                    })
                    .eq('id', existing.id);
            }
        }

        return NextResponse.json({
            success: true,
            score: result.score,
            feedback: result.feedback,
            rubric: result.rubric,
            passed: result.score >= 60,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Summary evaluation error:', message);
        return NextResponse.json(
            { error: `Summary evaluation failed: ${message}` },
            { status: 500 }
        );
    }
}
