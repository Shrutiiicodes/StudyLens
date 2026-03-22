import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

/**
 * GET /api/concepts?userId=xxx
 * Get all concepts for a user from Supabase.
 */
export async function GET(request: NextRequest) {
    try {
        const userId = request.nextUrl.searchParams.get('userId');

        if (!userId) {
            return NextResponse.json({ error: 'userId is required' }, { status: 400 });
        }

        const { data: concepts, error } = await supabase
            .from('concepts')
            .select('id, title, source_document, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Concepts fetch error:', error);
            return NextResponse.json({ error: 'Failed to fetch concepts' }, { status: 500 });
        }

        return NextResponse.json({
            success: true,
            concepts: concepts || [],
        });
    } catch (error) {
        console.error('Concepts API error:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}
