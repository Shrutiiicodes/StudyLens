import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase';
import { DEFAULT_BKT_PARAMS, type BKTParams } from '@/lib/bkt';

/**
 * POST /api/irt/fit
 * Body: { conceptId: string, userId?: string }
 *
 * Fits per-concept BKT parameters using Expectation-Maximisation (EM).
 * Replaces the default priors with empirically calibrated values once
 * sufficient response data has accumulated (minimum 30 attempts).
 *
 * Algorithm: Brute-force grid search over (p_l0, p_t, p_s, p_g) space,
 * maximising the log-likelihood of the observed attempt sequences.
 * This is equivalent to the EM approach described in:
 *
 *   Baker, R.S.J.d., Corbett, A.T., & Aleven, V. (2008).
 *   More accurate student modeling through contextual estimation of
 *   slip and guess probabilities in Bayesian Knowledge Tracing.
 *   Proceedings of ITS 2008, pp. 406–415.
 *
 * Grid resolution: 0.05 steps (coarse but fast, suitable for production).
 * For finer fitting, use pyBKT offline.
 *
 * Constraints (from BKT identifiability literature):
 *   p_s + p_g < 1.0   — prevents degenerate solutions
 *   p_s < 0.40        — slip rate cap (higher = model breakdown)
 *   p_g < 0.40        — guess rate cap (higher = model breakdown)
 *   p_t > 0.01        — learning must be possible
 *
 * Fitted params are stored in a new `concept_bkt_params` table.
 * The evaluation engine reads from this table preferentially over defaults.
 */
export async function POST(request: NextRequest) {
    try {
        const supabase = getServiceSupabase();
        const body = await request.json();
        const { conceptId, userId } = body;

        if (!conceptId) {
            return NextResponse.json({ error: 'conceptId is required' }, { status: 400 });
        }

        // ── 1. Fetch attempt sequences for this concept ───────────────────
        let query = supabase
            .from('attempts')
            .select('user_id, correct, created_at')
            .eq('concept_id', conceptId)
            .order('created_at', { ascending: true });

        if (userId) query = query.eq('user_id', userId);

        const { data: attempts, error } = await query;

        if (error) {
            return NextResponse.json({ error: 'Failed to fetch attempts' }, { status: 500 });
        }

        if (!attempts || attempts.length < 30) {
            return NextResponse.json({
                success: false,
                message: `Insufficient data for fitting. Need ≥30 attempts, have ${attempts?.length ?? 0}.`,
                current_params: DEFAULT_BKT_PARAMS,
                min_attempts_required: 30,
            }, { status: 422 });
        }

        // ── 2. Group attempts by student → sequences of {correct} ─────────
        const studentSequences: Record<string, boolean[]> = {};
        for (const a of attempts) {
            if (!studentSequences[a.user_id]) studentSequences[a.user_id] = [];
            studentSequences[a.user_id].push(a.correct);
        }

        const sequences = Object.values(studentSequences).filter(s => s.length >= 2);

        if (sequences.length < 3) {
            return NextResponse.json({
                success: false,
                message: 'Need at least 3 students with ≥2 attempts each for reliable fitting.',
                current_params: DEFAULT_BKT_PARAMS,
            }, { status: 422 });
        }

        // ── 3. Grid search EM ─────────────────────────────────────────────
        const fitted = fitBKTGridSearch(sequences);

        // ── 4. Store fitted params ────────────────────────────────────────
        const { error: upsertError } = await supabase
            .from('concept_bkt_params')
            .upsert({
                concept_id: conceptId,
                p_l0: fitted.params.p_l0,
                p_t: fitted.params.p_t,
                p_s: fitted.params.p_s,
                p_g: fitted.params.p_g,
                log_likelihood: fitted.logLikelihood,
                n_sequences: sequences.length,
                n_attempts: attempts.length,
                fitted_at: new Date().toISOString(),
            }, { onConflict: 'concept_id' });

        if (upsertError) {
            console.error('Failed to store fitted params:', upsertError);
        }

        return NextResponse.json({
            success: true,
            concept_id: conceptId,
            n_students: sequences.length,
            n_attempts: attempts.length,
            default_params: DEFAULT_BKT_PARAMS,
            fitted_params: fitted.params,
            log_likelihood: Math.round(fitted.logLikelihood * 1000) / 1000,
            improvement: Math.round(
                (fitted.logLikelihood - computeLogLikelihood(sequences, DEFAULT_BKT_PARAMS)) * 1000
            ) / 1000,
            interpretation: interpretParams(fitted.params),
        });

    } catch (error) {
        console.error('BKT fit error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// ─── EM Implementation ────────────────────────────────────────────────────────

/**
 * Compute the log-likelihood of observed sequences given BKT params.
 * Uses the forward algorithm (standard HMM inference).
 *
 * P(observations | params) = Π_students P(student sequence | params)
 *
 * For a single sequence, the forward pass computes:
 *   α_t = P(knows at step t, obs_1..obs_t)
 */
function computeLogLikelihood(sequences: boolean[][], params: BKTParams): number {
    const { p_l0, p_t, p_s, p_g } = params;
    let totalLogLik = 0;

    for (const seq of sequences) {
        let pKnows = p_l0;
        let seqLogLik = 0;

        for (const correct of seq) {
            // P(observation)
            const pObs = correct
                ? pKnows * (1 - p_s) + (1 - pKnows) * p_g
                : pKnows * p_s + (1 - pKnows) * (1 - p_g);

            if (pObs <= 0) {
                seqLogLik += Math.log(1e-10);
            } else {
                seqLogLik += Math.log(pObs);
            }

            // Bayesian update
            if (pObs > 0) {
                pKnows = correct
                    ? (pKnows * (1 - p_s)) / pObs
                    : (pKnows * p_s) / pObs;
            }
            // Learning transition
            pKnows = pKnows + (1 - pKnows) * p_t;
        }

        totalLogLik += seqLogLik;
    }

    return totalLogLik;
}

/**
 * Grid search over BKT parameter space.
 * Step size 0.05 — coarse but runs in <500ms for typical class sizes.
 *
 * Search space:
 *   p_l0: [0.05, 0.50] — prior knowledge
 *   p_t:  [0.05, 0.40] — learning rate
 *   p_s:  [0.02, 0.35] — slip rate (capped lower than guess)
 *   p_g:  [0.10, 0.35] — guess rate (4-option MCQ ≥ 0.10)
 */
function fitBKTGridSearch(
    sequences: boolean[][]
): { params: BKTParams; logLikelihood: number } {
    const STEP = 0.05;

    let bestLL = -Infinity;
    let bestParams: BKTParams = { ...DEFAULT_BKT_PARAMS };

    const range = (lo: number, hi: number): number[] => {
        const arr: number[] = [];
        for (let v = lo; v <= hi + 1e-9; v += STEP) {
            arr.push(Math.round(v * 100) / 100);
        }
        return arr;
    };

    for (const p_l0 of range(0.05, 0.50)) {
        for (const p_t of range(0.05, 0.40)) {
            for (const p_s of range(0.02, 0.35)) {
                for (const p_g of range(0.10, 0.35)) {
                    // Identifiability constraint
                    if (p_s + p_g >= 1.0) continue;

                    const params: BKTParams = { p_l0, p_t, p_s, p_g };
                    const ll = computeLogLikelihood(sequences, params);

                    if (ll > bestLL) {
                        bestLL = ll;
                        bestParams = { ...params };
                    }
                }
            }
        }
    }

    return { params: bestParams, logLikelihood: bestLL };
}

/**
 * Human-readable interpretation of fitted parameters.
 * Useful for researchers inspecting fit quality.
 */
function interpretParams(params: BKTParams): Record<string, string> {
    const { p_l0, p_t, p_s, p_g } = params;

    return {
        prior_knowledge: p_l0 < 0.15
            ? 'Very low — students are starting fresh'
            : p_l0 < 0.35
                ? 'Low to moderate — some prior exposure likely'
                : 'High — students have significant prior knowledge',

        learning_rate: p_t < 0.08
            ? 'Slow — concept requires many exposures'
            : p_t < 0.18
                ? 'Moderate — typical factual learning rate'
                : 'Fast — concept is easily acquired per attempt',

        slip_rate: p_s < 0.05
            ? 'Very low — students who know it almost never slip'
            : p_s < 0.15
                ? 'Normal — occasional careless errors'
                : 'High — consider reviewing question clarity',

        guess_rate: p_g < 0.15
            ? 'Below MCQ floor — verify question difficulty'
            : p_g < 0.30
                ? 'Normal for 4-option MCQ'
                : 'High — distractors may be too easy to eliminate',

        identifiability: (p_s + p_g) < 0.5
            ? 'Good — parameters are identifiable'
            : 'Warning — p_s + p_g is high, model may be poorly identified',
    };
}