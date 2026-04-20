import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase';

/**
 * GET /api/export?userId=xxx
 * Exports a research-grade CSV of all attempt-level data for a student.
 * Includes every field needed for ITS/knowledge-tracing paper analysis.
 *
 * GET /api/export?userId=xxx&conceptId=xxx
 * Scoped to a single concept.
 *
 * GET /api/export?userId=xxx&format=json
 * Returns JSON instead of CSV (useful for programmatic analysis).
 *
 * Columns exported (matches standard KT dataset format):
 *   student_id, concept_id, question_id, attempt_index,
 *   correct, confidence, time_taken_s, difficulty_label,
 *   difficulty_param (Rasch b_i), student_theta (IRT θ),
 *   cognitive_level, mode, is_spaced_review,
 *   session_id, created_at
 *
 * Session-level columns (joined from sessions table):
 *   session_score, session_passed, nlg, brier_score, ece, log_loss,
 *   fas, wbs, ccms, mss, lip
 *
 * Citation: This format is compatible with the ASSISTments dataset schema
 * (Feng et al., 2009) and the standard input format for pyBKT, DKT, and
 * SAINT+ knowledge tracing models.
 */
export async function GET(request: NextRequest) {
    try {
        const supabase = getServiceSupabase();
        const { searchParams } = new URL(request.url);

        const userId = searchParams.get('userId');
        const conceptId = searchParams.get('conceptId');
        const format = searchParams.get('format') ?? 'csv';

        if (!userId) {
            return NextResponse.json({ error: 'userId is required' }, { status: 400 });
        }

        // ── 1. Fetch all attempts ─────────────────────────────────────────
        let attemptsQuery = supabase
            .from('attempts')
            .select(`
                id,
                user_id,
                concept_id,
                question_id,
                correct,
                confidence,
                time_taken,
                difficulty,
                cognitive_level,
                mode,
                session_id,
                difficulty_param,
                student_theta,
                is_spaced_review,
                created_at
            `)
            .eq('user_id', userId)
            .order('created_at', { ascending: true });

        if (conceptId) attemptsQuery = attemptsQuery.eq('concept_id', conceptId);

        const { data: attempts, error: attemptsError } = await attemptsQuery;

        if (attemptsError) {
            return NextResponse.json({ error: 'Failed to fetch attempts' }, { status: 500 });
        }

        if (!attempts || attempts.length === 0) {
            return NextResponse.json({ error: 'No attempt data found for this user' }, { status: 404 });
        }

        // ── 2. Fetch session metrics to join ──────────────────────────────
        const sessionIds = [...new Set(
            attempts.map(a => a.session_id).filter(Boolean)
        )];

        const sessionMap: Record<string, Record<string, unknown>> = {};

        if (sessionIds.length > 0) {
            const { data: sessions } = await supabase
                .from('sessions')
                .select('id, score, passed, nlg, brier_score, ece, log_loss, fas, wbs, ccms, mss, lip')
                .in('id', sessionIds);

            for (const s of sessions ?? []) {
                sessionMap[s.id] = s;
            }
        }

        // ── 3. Fetch concept titles for readability ───────────────────────
        const conceptIds = [...new Set(attempts.map(a => a.concept_id).filter(Boolean))];
        const conceptMap: Record<string, string> = {};

        if (conceptIds.length > 0) {
            const { data: concepts } = await supabase
                .from('concepts')
                .select('id, title')
                .in('id', conceptIds);

            for (const c of concepts ?? []) {
                conceptMap[c.id] = c.title;
            }
        }

        // ── 4. Build per-attempt attempt_index (order within concept) ─────
        const conceptAttemptCounter: Record<string, number> = {};

        // ── 5. Assemble rows ──────────────────────────────────────────────
        const rows = attempts.map(a => {
            const conceptKey = `${a.user_id}::${a.concept_id}`;
            conceptAttemptCounter[conceptKey] = (conceptAttemptCounter[conceptKey] ?? 0) + 1;
            const attemptIndex = conceptAttemptCounter[conceptKey];

            const session = a.session_id ? sessionMap[a.session_id] : null;

            // Spaced review: attempts where mode column was stored as 'spaced'
            // (injected by question-generator silent injection)
            const isSpacedReview = a.is_spaced_review ? 1 : 0;
            const cleanMode = a.mode ?? 'unknown';

            return {
                student_id: a.user_id,
                concept_id: a.concept_id,
                concept_title: conceptMap[a.concept_id] ?? '',
                question_id: a.question_id,
                attempt_index: attemptIndex,
                correct: a.correct ? 1 : 0,
                confidence: a.confidence ?? '',
                time_taken_s: a.time_taken ?? '',
                difficulty_label: a.difficulty ?? '',
                difficulty_param: a.difficulty_param ?? '',
                student_theta: a.student_theta ?? '',
                cognitive_level: a.cognitive_level ?? '',
                mode: cleanMode,
                is_spaced_review: isSpacedReview,
                session_id: a.session_id ?? '',
                session_score: session ? session.score : '',
                session_passed: session ? (session.passed ? 1 : 0) : '',
                nlg: session ? (session.nlg ?? '') : '',
                brier_score: session ? (session.brier_score ?? '') : '',
                ece: session ? (session.ece ?? '') : '',
                log_loss: session ? (session.log_loss ?? '') : '',
                fas: session ? (session.fas ?? '') : '',
                wbs: session ? (session.wbs ?? '') : '',
                ccms: session ? (session.ccms ?? '') : '',
                mss: session ? (session.mss ?? '') : '',
                lip: session ? (session.lip ?? '') : '',
                created_at: a.created_at,
            };
        });

        // ── 6. Return as JSON or CSV ──────────────────────────────────────
        if (format === 'json') {
            return NextResponse.json({
                success: true,
                student_id: userId,
                total_attempts: rows.length,
                exported_at: new Date().toISOString(),
                schema_reference: 'Compatible with ASSISTments dataset format (Feng et al., 2009)',
                data: rows,
            });
        }

        // CSV output
        const headers = Object.keys(rows[0]);
        const csvLines = [
            // Metadata header comments
            `# Study Lens Research Export`,
            `# student_id: ${userId}`,
            `# exported_at: ${new Date().toISOString()}`,
            `# total_attempts: ${rows.length}`,
            `# schema: Compatible with ASSISTments dataset format (Feng et al., 2009)`,
            `# IRT params: Rasch (1960), Baker et al. (2008)`,
            `# Session metrics: NLG (Hake 1998), Brier (1950), ECE (Guo et al. 2017)`,
            `#`,
            headers.join(','),
            ...rows.map(row =>
                headers.map(h => {
                    const val = String(row[h as keyof typeof row] ?? '');
                    // Escape commas and quotes in values
                    return val.includes(',') || val.includes('"')
                        ? `"${val.replace(/"/g, '""')}"`
                        : val;
                }).join(',')
            ),
        ];

        const csv = csvLines.join('\n');

        return new NextResponse(csv, {
            status: 200,
            headers: {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': `attachment; filename="studylens_research_export_${userId.slice(0, 8)}_${Date.now()}.csv"`,
                'Cache-Control': 'no-store',
            },
        });

    } catch (error) {
        console.error('Export API error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}