import { NextRequest, NextResponse } from 'next/server';
import { generateQuestionsForMode } from '@/lib/question-generator';
import { evaluateDiagnostic } from '@/lib/evaluation-engine';
import { QuestionResult } from '@/types/mastery';

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
            if (!conceptId || !conceptTitle) {
                return NextResponse.json(
                    { error: 'conceptId and conceptTitle are required' },
                    { status: 400 }
                );
            }

            const assessmentMode = mode || 'diagnostic';
            const questions = await generateQuestionsForMode(conceptId, conceptTitle, assessmentMode);

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
