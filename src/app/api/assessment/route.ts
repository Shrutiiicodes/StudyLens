import { NextRequest, NextResponse } from 'next/server';
import { generateAssessmentQuestions } from '@/lib/question-generator';
import { evaluateAnswer } from '@/lib/evaluation-engine';
import { sampleDifficulty } from '@/lib/personalization-engine';
import { Question, QuestionType, DifficultyLevel } from '@/types/question';
import { AssessmentMode } from '@/types/student';

/**
 * POST /api/assessment
 * Handle all assessment modes: practice, mastery, spaced
 */
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { action } = body;

        if (action === 'generate') {
            const {
                conceptId,
                conceptTitle,
                type,
                difficulty,
                mastery,
                count = 1,
            } = body;

            if (!conceptId || !conceptTitle) {
                return NextResponse.json(
                    { error: 'conceptId and conceptTitle are required' },
                    { status: 400 }
                );
            }

            // Auto-sample difficulty if not specified
            const finalDifficulty: DifficultyLevel =
                difficulty || sampleDifficulty(mastery || 50);

            // Default to a random question type if not specified
            const questionTypes: QuestionType[] = [
                'recall',
                'conceptual',
                'application',
                'reasoning',
                'analytical',
            ];
            const finalType: QuestionType =
                type || questionTypes[Math.floor(Math.random() * questionTypes.length)];

            const questions = await generateAssessmentQuestions(
                conceptId,
                conceptTitle,
                finalType,
                finalDifficulty,
                count
            );

            return NextResponse.json({
                success: true,
                questions,
                metadata: {
                    difficulty: finalDifficulty,
                    type: finalType,
                    count: questions.length,
                },
            });
        }

        if (action === 'evaluate') {
            const { userId, question, submission, mode } = body;

            if (!userId || !question || !submission || !mode) {
                return NextResponse.json(
                    { error: 'userId, question, submission, and mode are required' },
                    { status: 400 }
                );
            }

            const result = await evaluateAnswer(
                userId,
                question as Question,
                submission,
                mode as AssessmentMode
            );

            return NextResponse.json({
                success: true,
                result,
            });
        }

        return NextResponse.json(
            { error: 'Invalid action. Use "generate" or "evaluate"' },
            { status: 400 }
        );
    } catch (error) {
        console.error('Assessment error:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}
