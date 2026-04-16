import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase';

/**
 * GET /api/history?userId=xxx
 * Returns all sessions for a user, newest first, joined with concept titles.
 * Used by the history page to replace the old hardcoded demo data.
 */
export async function GET(request: NextRequest) {
    try {
        const supabase = getServiceSupabase();
        const userId = request.nextUrl.searchParams.get('userId');

        if (!userId) {
            return NextResponse.json({ error: 'userId is required' }, { status: 400 });
        }

        // Fetch sessions with concept title joined
        const { data: sessions, error } = await supabase
            .from('sessions')
            .select(`
                id,
                concept_id,
                mode,
                score,
                passed,
                nlg,
                brier_score,
                created_at,
                concepts (title)
            `)
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(100);

        if (error) {
            console.error('History fetch error:', error);
            return NextResponse.json({ error: 'Failed to fetch history' }, { status: 500 });
        }

        const formatted = (sessions ?? []).map(s => ({
            id: s.id,
            concept_id: s.concept_id,
            concept_title: (s.concepts as unknown as { title: string })?.title ?? 'Unknown Concept',
            mode: s.mode,
            score: s.score ?? 0,
            passed: s.passed ?? false,
            nlg: s.nlg ?? null,
            brier_score: s.brier_score ?? null,
            created_at: s.created_at,
        }));

        return NextResponse.json({ success: true, sessions: formatted });

    } catch (error) {
        console.error('History API error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}