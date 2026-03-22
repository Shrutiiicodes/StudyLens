import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase';
import { calculateStudentSAI } from '@/lib/evaluation-engine';

export async function GET(request: NextRequest) {
    try {
        const userId = request.nextUrl.searchParams.get('userId');
        const supabase = getServiceSupabase();

        if (!userId) {
            return NextResponse.json({ error: 'userId is required' }, { status: 400 });
        }

        // 1. Calculate Ability Index (SAI)
        const abilityIndex = await calculateStudentSAI(userId);

        // 2. Count Tests Taken from the new sessions table
        const { count, error: countError } = await supabase
            .from('sessions')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId);

        if (countError) {
            console.error('Failed to count sessions:', countError);
        }

        return NextResponse.json({
            success: true,
            stats: {
                testsTaken: count || 0,
                abilityIndex: abilityIndex,
            }
        });

    } catch (error) {
        console.error('Stats API error:', error);
        return NextResponse.json({
            success: false,
            stats: {
                testsTaken: 0,
                abilityIndex: 0,
            }
        });
    }
}
