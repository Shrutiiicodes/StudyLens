import { NextRequest, NextResponse } from 'next/server';
import { generateQuestionsForMode } from '@/lib/question-generator';
import { evaluateDiagnostic } from '@/lib/evaluation-engine';
import { QuestionResult } from '@/types/mastery';
export const maxDuration = 60;
export const runtime = 'nodejs';

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
                metrics: {
                    // ── Legacy custom metrics ──────────────────────────────
                    fas: r4(diagnostic.metrics.fas),
                    wbs: r4(diagnostic.metrics.wbs),
                    ccms: r4(diagnostic.metrics.ccms),
                    mss: r4(diagnostic.metrics.mss),
                    lip: r4(diagnostic.metrics.lip),
                    rci_avg: r4(diagnostic.metrics.rci_avg),
                    calibration_error: r4(diagnostic.metrics.calibration_error),
                    // ── Standard ITS metrics ───────────────────────────────
                    nlg: r4(diagnostic.metrics.nlg),
                    brier_score: r4(diagnostic.metrics.brier_score),
                    ece: r4(diagnostic.metrics.ece),
                    log_loss: r4(diagnostic.metrics.log_loss),
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

function r4(value: number | undefined): number {
    if (value == null) return 0;
    return Math.round(value * 10000) / 10000;
}