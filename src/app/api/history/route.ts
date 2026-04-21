import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase';

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

        // Fetch all incorrect attempts for this user — for weak topics analysis
        const { data: incorrectAttempts } = await supabase
            .from('attempts')
            .select('concept_id, question_text, correct_answer, difficulty, cognitive_level, mode, created_at')
            .eq('user_id', userId)
            .eq('correct', false)
            .not('question_text', 'is', null)
            .order('created_at', { ascending: false });

        // Fetch all attempts for question-type breakdown per session
        const { data: allAttempts } = await supabase
            .from('attempts')
            .select('concept_id, correct, difficulty, cognitive_level, question_type, session_id')
            .eq('user_id', userId);

        // ── Build weak topics map ─────────────────────────────────────────
        // Group incorrect attempts by concept_id
        const weakTopicsMap: Record<string, {
            concept_id: string;
            concept_title: string;
            incorrect_count: number;
            questions: Array<{ question_text: string; correct_answer: string; difficulty: number }>;
        }> = {};

        // Get concept titles from sessions data
        const conceptTitleMap: Record<string, string> = {};
        for (const s of sessions ?? []) {
            conceptTitleMap[s.concept_id] = (s.concepts as unknown as { title: string })?.title ?? 'Unknown';
        }

        for (const attempt of incorrectAttempts ?? []) {
            if (!weakTopicsMap[attempt.concept_id]) {
                weakTopicsMap[attempt.concept_id] = {
                    concept_id: attempt.concept_id,
                    concept_title: conceptTitleMap[attempt.concept_id] ?? 'Unknown Concept',
                    incorrect_count: 0,
                    questions: [],
                };
            }
            weakTopicsMap[attempt.concept_id].incorrect_count += 1;
            if (weakTopicsMap[attempt.concept_id].questions.length < 3) {
                weakTopicsMap[attempt.concept_id].questions.push({
                    question_text: attempt.question_text,
                    correct_answer: attempt.correct_answer,
                    difficulty: attempt.difficulty,
                });
            }
        }

        const weakTopics = Object.values(weakTopicsMap)
            .sort((a, b) => b.incorrect_count - a.incorrect_count)
            .slice(0, 5); // top 5 weakest topics

        // ── Build per-session attempt breakdown ───────────────────────────
        const sessionBreakdownMap: Record<string, {
            total: number;
            correct: number;
            by_difficulty: { easy: number; medium: number; hard: number };
            by_difficulty_incorrect: { easy: number; medium: number; hard: number };
            by_type: Record<string, { total: number; incorrect: number }>;
        }> = {};

        for (const attempt of allAttempts ?? []) {
            const sid = attempt.session_id;
            if (!sid) continue;

            if (!sessionBreakdownMap[sid]) {
                sessionBreakdownMap[sid] = {
                    total: 0,
                    correct: 0,
                    by_difficulty: { easy: 0, medium: 0, hard: 0 },
                    by_difficulty_incorrect: { easy: 0, medium: 0, hard: 0 },
                    by_type: {},
                };
            }

            const b = sessionBreakdownMap[sid];
            b.total += 1;
            if (attempt.correct) b.correct += 1;

            // Difficulty
            const diffKey = attempt.difficulty === 1 ? 'easy' : attempt.difficulty === 2 ? 'medium' : 'hard';
            b.by_difficulty[diffKey] += 1;
            if (!attempt.correct) b.by_difficulty_incorrect[diffKey] += 1;

            // Question type via cognitive_level proxy
            const typeKey = attempt.question_type ?? 'recall';
            if (!b.by_type[typeKey]) b.by_type[typeKey] = { total: 0, incorrect: 0 };
            b.by_type[typeKey].total += 1;
            if (!attempt.correct) b.by_type[typeKey].incorrect += 1;
        }

        // ── Format sessions ───────────────────────────────────────────────
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
            breakdown: sessionBreakdownMap[s.id] ?? null,
        }));

        return NextResponse.json({
            success: true,
            sessions: formatted,
            weakTopics,
        });

    } catch (error) {
        console.error('History API error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}