import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase';

/**
 * DELETE /api/concepts/[id]?userId=xxx
 * Deletes a concept and all associated data for a user.
 */
export async function DELETE(
    request: NextRequest,
    { params }: { params: { id: string } }
) {
    try {
        const supabase = getServiceSupabase();
        const conceptId = params.id;
        const userId = request.nextUrl.searchParams.get('userId');

        if (!userId) {
            return NextResponse.json({ error: 'userId is required' }, { status: 400 });
        }

        // Verify the concept belongs to this user before deleting
        const { data: concept, error: fetchError } = await supabase
            .from('concepts')
            .select('id, source_document')
            .eq('id', conceptId)
            .eq('user_id', userId)
            .single();

        if (fetchError || !concept) {
            return NextResponse.json({ error: 'Concept not found or access denied' }, { status: 404 });
        }

        // Delete in order: child tables first, then parent concept
        const errors: string[] = [];

        // 1. Delete attempts linked to sessions for this concept
        const { error: attemptsError } = await supabase
            .from('attempts')
            .delete()
            .eq('concept_id', conceptId)
            .eq('user_id', userId);
        if (attemptsError) errors.push(`attempts: ${attemptsError.message}`);

        // 2. Delete sessions
        const { error: sessionsError } = await supabase
            .from('sessions')
            .delete()
            .eq('concept_id', conceptId)
            .eq('user_id', userId);
        if (sessionsError) errors.push(`sessions: ${sessionsError.message}`);

        // 3. Delete mastery record
        const { error: masteryError } = await supabase
            .from('mastery')
            .delete()
            .eq('concept_id', conceptId)
            .eq('user_id', userId);
        if (masteryError) errors.push(`mastery: ${masteryError.message}`);

        // 4. Delete pipeline_runs record
        const { error: pipelineError } = await supabase
            .from('pipeline_runs')
            .delete()
            .eq('concept_id', conceptId)
            .eq('user_id', userId);
        if (pipelineError) errors.push(`pipeline_runs: ${pipelineError.message}`);

        // 5. Delete the file from Supabase Storage
        if (concept.source_document) {
            const { error: storageError } = await supabase.storage
                .from('documents')
                .remove([concept.source_document]);
            if (storageError) errors.push(`storage: ${storageError.message}`);
        }

        // 6. Delete the concept record itself
        const { error: conceptError } = await supabase
            .from('concepts')
            .delete()
            .eq('id', conceptId)
            .eq('user_id', userId);

        if (conceptError) {
            return NextResponse.json(
                { error: 'Failed to delete concept', details: conceptError.message },
                { status: 500 }
            );
        }

        return NextResponse.json({
            success: true,
            message: 'Concept and all associated data deleted',
            ...(errors.length > 0 && { warnings: errors }),
        });

    } catch (error) {
        console.error('Delete concept error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
