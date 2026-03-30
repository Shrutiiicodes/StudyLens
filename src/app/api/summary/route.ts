import { NextRequest, NextResponse } from 'next/server';
import { getConceptContext } from '@/lib/question-generator';
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
                        // Use first 3000 chars — enough context without overwhelming the LLM
                        context = fullText.substring(0, 3000);
                        console.log('[Summary] Neo4j context empty — fell back to source document');
                    }
                }
            } catch (fallbackError) {
                console.warn('[Summary] Source document fallback failed:', fallbackError);
            }
        }

        // Last resort — at least give the LLM the concept title as context
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
                .select('id, mastery_score')
                .eq('user_id', userId)
                .eq('concept_id', conceptId)
                .single();

            if (existing) {
                // If student has high MSS, cap mastery gain — misconceptions
                // need more reinforcement before marking fully complete
                let mss = 0;

                // High MSS (>0.5) = misconceptions still present
                // Cap mastery at 85 instead of allowing full 100
                // so the system continues to surface this concept for review
                const mssPenalty = mss > 0.5 ? 0.85 : 1.0;
                const finalScore = Math.min(100, Math.max(result.score, 80) * mssPenalty);

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
