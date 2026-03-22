import { NextRequest, NextResponse } from 'next/server';
import { generateQuestionsForMode } from '@/lib/question-generator';
import { evaluateDiagnostic } from '@/lib/evaluation-engine';
import { QuestionResult } from '@/types/mastery';
import { getServiceSupabase } from '@/lib/supabase';

const supabase = { from: (...args: any[]) => getServiceSupabase().from(...args) };
const STAGES_ORDER = ['diagnostic', 'practice', 'mastery', 'spaced', 'summary'] as const;
const PASS_THRESHOLD = 60;

/**
 * POST /api/diagnostic
 * Generate questions or evaluate results for any assessment mode.
 */
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { action, conceptId, conceptTitle, userId, results, mode } = body;

        if (action === 'generate') {
            const assessmentMode = mode || 'diagnostic';

            // For non-diagnostic modes, fetch current decayed mastery
            // so difficulty sampling adapts to what the student currently knows
            let currentMastery = 50; // neutral default

            if (assessmentMode !== 'diagnostic' && userId) {
                const { data: masteryRecord } = await supabase
                    .from('mastery')
                    .select('mastery_score, last_updated')
                    .eq('user_id', userId)
                    .eq('concept_id', conceptId)
                    .single();

                if (masteryRecord) {
                    const hoursElapsed = masteryRecord.last_updated
                        ? (Date.now() - new Date(masteryRecord.last_updated).getTime()) / (1000 * 60 * 60)
                        : 0;
                    // Apply forgetting model so difficulty reflects current state, not peak mastery
                    currentMastery = masteryRecord.mastery_score * Math.exp(-0.05 * (hoursElapsed / 24));
                    currentMastery = Math.max(0, Math.min(100, currentMastery));
                }
            }

            const questions = await generateQuestionsForMode(
                conceptId,
                conceptTitle,
                assessmentMode,
                currentMastery
            );

            return NextResponse.json({
                success: true,
                questions,
                count: questions.length,
                mode: assessmentMode,
            });
        }

        if (action === 'evaluate') {
            if (!userId || !conceptId || !results) {
                return NextResponse.json(
                    { error: 'userId, conceptId, and results are required' },
                    { status: 400 }
                );
            }

            const assessmentMode = mode || 'diagnostic';
            const questionResults: QuestionResult[] = results;
            const diagnostic = await evaluateDiagnostic(userId, conceptId, questionResults, assessmentMode);

            return NextResponse.json({
                success: true,
                initialMastery: diagnostic.initialMastery,
                recommendedPath: diagnostic.recommendedPath,
                masteryUpdate: diagnostic.masteryUpdate,
                nextStage: diagnostic.nextStage,
                passed: diagnostic.passed,
            });
        }

        return NextResponse.json(
            { error: 'Invalid action. Use "generate" or "evaluate"' },
            { status: 400 }
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : '';
        console.error('Diagnostic error:', message, stack);
        return NextResponse.json(
            { error: `Diagnostic failed: ${message}` },
            { status: 500 }
        );
    }
}
