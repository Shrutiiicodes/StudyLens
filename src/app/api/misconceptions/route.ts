import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase';

/**
 * GET /api/misconceptions?userId=xxx&conceptId=xxx
 * GET /api/misconceptions?userId=xxx&sessionId=xxx
 *
 * Fetch misconception records for a user, optionally filtered by concept or session.
 */
export async function GET(request: NextRequest) {
    try {
        const userId = request.nextUrl.searchParams.get('userId');
        const conceptId = request.nextUrl.searchParams.get('conceptId');
        const sessionId = request.nextUrl.searchParams.get('sessionId');

        if (!userId) {
            return NextResponse.json({ error: 'userId is required' }, { status: 400 });
        }

        const supabase = getServiceSupabase();

        let query = supabase
            .from('misconceptions')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (conceptId) query = query.eq('concept_id', conceptId);
        if (sessionId) query = query.eq('session_id', sessionId);

        const { data, error } = await query;

        if (error) {
            console.error('Misconceptions fetch error:', error);
            return NextResponse.json(
                { error: 'Failed to fetch misconceptions' },
                { status: 500 }
            );
        }

        // Build summary stats
        const total = data?.length ?? 0;
        const severityDist: Record<string, number> = {
            CORRECT: 0, CLOSE: 0, PARTIAL: 0, CRITICAL: 0,
        };
        for (const m of data ?? []) {
            if (m.severity) severityDist[m.severity] = (severityDist[m.severity] ?? 0) + 1;
        }

        const criticalGaps = (data ?? [])
            .filter((m) => m.severity === 'CRITICAL')
            .map((m) => m.misconception_label)
            .filter(Boolean);

        return NextResponse.json({
            success: true,
            misconceptions: data ?? [],
            summary: {
                total,
                severityDistribution: severityDist,
                criticalGaps,
            },
        });
    } catch (error) {
        console.error('Misconceptions API error:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}