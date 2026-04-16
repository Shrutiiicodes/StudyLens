import { NextRequest, NextResponse } from 'next/server';
import { getConceptContext } from '@/lib/question-generator';
import { getServiceSupabase } from '@/lib/supabase';
import { PASS_THRESHOLD } from '@/config/constants';

/**
 * POST /api/summary
 * Evaluate a student's written summary of a concept.
 * Pass threshold: PASS_THRESHOLD (80%) per Bloom (1984) mastery learning.
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
        let context = await getConceptContext(conceptId);

        // If Neo4j returned empty or minimal context, fall back to the source document
        if (!context || context === '[]' || context.length < 50) {
            try {
                const supabaseService = getServiceSupabase();

                const { data: concept } = await supabaseService
                    .from('concepts')
                    .select('source_document')
                    .eq('id', conceptId)
                    .single();

                if (concept?.source_document) {
                    const { data: fileData, error: downloadError } = await supabaseService
                        .storage
                        .from('documents')
                        .download(concept.source_document);

                    if (!downloadError && fileData) {
                        const fullText = await fileData.text();
                        context = fullText.substring(0, 3000);
                        console.log('[Summary] Neo4j context empty — fell back to source document');
                    }
                }
            } catch (fallbackError) {
                console.warn('[Summary] Source document fallback failed:', fallbackError);
            }
        }

        const evaluationContext = (context && context.length > 50)
            ? context
            : `This summary is about the concept: ${conceptTitle}`;

        // Evaluate with LLM
        const result = await evaluateSummary(conceptTitle, evaluationContext, summary);

        const supabase = getServiceSupabase();

        // Store the summary attempt
        await supabase.from('attempts').insert({
            user_id: userId,
            concept_id: conceptId,
            question_id: `summary_${Date.now()}`,
            correct: result.score >= PASS_THRESHOLD,
            difficulty: 3,
            cognitive_level: 5,
            time_taken: 0,
            confidence: 1,
            mode: 'summary',
        });

        // If passed, mark concept as complete
        if (result.score >= PASS_THRESHOLD) {
            const { data: existing } = await supabase
                .from('mastery')
                .select('id, mastery_score')
                .eq('user_id', userId)
                .eq('concept_id', conceptId)
                .single();

            if (existing) {
                // High MSS (>0.5) = misconceptions still present.
                // Cap mastery at 85 so the system continues surfacing the concept for review.
                let mss = 0;
                const mssPenalty = mss > 0.5 ? 0.85 : 1.0;
                const finalScore = Math.min(100, Math.max(result.score, PASS_THRESHOLD) * mssPenalty);

                await supabase
                    .from('mastery')
                    .update({
                        current_stage: 'complete',
                        mastery_score: Math.round(finalScore),
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
            passed: result.score >= PASS_THRESHOLD,
            pass_threshold: PASS_THRESHOLD,
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

// ─── LLM Summary Evaluator ────────────────────────────────────────────────────

async function evaluateSummary(
    conceptTitle: string,
    context: string,
    summary: string
): Promise<{ score: number; feedback: string; rubric: Record<string, number> }> {
    const { chatCompletion, parseLLMJson } = await import('@/lib/groq');

    const response = await chatCompletion(
        [
            {
                role: 'system',
                content: `You are an educational assessment expert evaluating student summaries of CBSE concepts.
Evaluate the summary on 4 criteria (0–25 points each, total 0–100):
1. Accuracy — factual correctness against the concept context
2. Completeness — covers key points without major omissions  
3. Clarity — clearly expressed in the student's own words
4. Depth — demonstrates understanding beyond surface recall

Respond ONLY with JSON:
{
  "accuracy": <0-25>,
  "completeness": <0-25>,
  "clarity": <0-25>,
  "depth": <0-25>,
  "total": <0-100>,
  "feedback": "<2-3 sentence constructive feedback>"
}`,
            },
            {
                role: 'user',
                content: `Concept: ${conceptTitle}

Reference context:
${context.substring(0, 2000)}

Student summary:
${summary}`,
            },
        ],
        { jsonMode: true, temperature: 0.2 }
    );

    const parsed = parseLLMJson<{
        accuracy: number;
        completeness: number;
        clarity: number;
        depth: number;
        total: number;
        feedback: string;
    }>(response);

    return {
        score: Math.min(100, Math.max(0, parsed.total ?? 0)),
        feedback: parsed.feedback ?? 'No feedback provided.',
        rubric: {
            accuracy: parsed.accuracy ?? 0,
            completeness: parsed.completeness ?? 0,
            clarity: parsed.clarity ?? 0,
            depth: parsed.depth ?? 0,
        },
    };
}