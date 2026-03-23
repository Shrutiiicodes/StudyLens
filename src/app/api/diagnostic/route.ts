import { NextRequest, NextResponse } from 'next/server';
import { generateQuestionsForMode } from '@/lib/question-generator';
import { evaluateDiagnostic } from '@/lib/evaluation-engine';
import { QuestionResult } from '@/types/mastery';

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
            const questions = await generateQuestionsForMode(conceptId, conceptTitle, assessmentMode, 50, userId);

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
                // * Now included in every evaluate response
                metrics: {
                    fas: roundTo(diagnostic.metrics.fas, 4),
                    wbs: roundTo(diagnostic.metrics.wbs, 4),
                    ccms: roundTo(diagnostic.metrics.ccms, 4),
                    mss: roundTo(diagnostic.metrics.mss, 4),
                    lip: roundTo(diagnostic.metrics.lip, 4),
                    rci_avg: roundTo(diagnostic.metrics.rci_avg, 4),
                    calibration_error: roundTo(diagnostic.metrics.calibration_error, 4),
                    // Human-readable labels for the frontend
                    labels: {
                        fas: 'Fractional Assessment Score',
                        wbs: 'Weighted Bloom Score',
                        ccms: 'Composite Confidence Mastery Score',
                        mss: 'Mastery Sensitivity Score',
                        lip: 'Learning Improvement Priority',
                        rci_avg: 'Avg Response Confidence Index',
                        calibration_error: 'Calibration Error',
                    },
                },
            });
        }

        return NextResponse.json(
            { error: 'Invalid action. Use "generate" or "evaluate"' },
            { status: 400 }
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Diagnostic error:', message);
        return NextResponse.json(
            { error: `Diagnostic failed: ${message}` },
            { status: 500 }
        );
    }
}

function roundTo(value: number | undefined, decimals: number): number {
    if (value == null) return 0;
    return Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals);
}