import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase';
import { calculateStudentSAI } from '@/lib/evaluation-engine';
import { getAuthedUserId } from '@/lib/auth';

export async function GET(_request: NextRequest) {
    try {
        const userId = await getAuthedUserId();
        if (!userId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const supabase = getServiceSupabase();

        const abilityIndex = await calculateStudentSAI(userId);

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
            },
        });
    } catch (error) {
        console.error('Stats API error:', error);
        return NextResponse.json({
            success: false,
            stats: { testsTaken: 0, abilityIndex: 0 },
        });
    }
}