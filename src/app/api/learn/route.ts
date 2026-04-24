import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase';
import { runCypher } from '@/lib/neo4j';
import { chatCompletion, parseLLMJson } from '@/lib/groq';
import { PROMPTS } from '@/config/prompts';
export const maxDuration = 60;
export const runtime = 'nodejs';
/**
 * GET /api/learn?conceptId=xxx&userId=xxx&grade=10
 *
 * Learn-mode content for the study interface.
 *
 * Three-tier resolution (cheap → expensive):
 *   1. KG path — concept has structured graph content. Zero LLM calls.
 *      Cached implicitly: the graph doesn't change between requests.
 *   2. Learn-content cache — prior LLM-generated content for this
 *      (concept, grade), within TTL. Zero LLM calls.
 *   3. LLM fallback — generate fresh and store in the cache.
 *
 * Past misconceptions are always fetched fresh (they're per-user and
 * change with every new wrong answer the student logs).
 */

// How long a cached LLM generation stays valid.
// The source document is immutable, so 30 days is conservative — the
// main reason to expire is to let prompt improvements roll over.
const LEARN_CACHE_TTL_DAYS = 30;

// LLM model used for generation — recorded in cache for audits and lets us
// invalidate selectively if we switch models later.
const LEARN_GENERATION_MODEL = 'llama-3.1-8b-instant';

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const conceptId = searchParams.get('conceptId');
        const userId = searchParams.get('userId');
        const grade = searchParams.get('grade') || '10';

        if (!conceptId) {
            return NextResponse.json({ error: 'Missing conceptId' }, { status: 400 });
        }

        const supabase = getServiceSupabase();

        // ── 1. Fetch concept from Supabase ──────────────────────────────
        const { data: concept, error: conceptError } = await supabase
            .from('concepts')
            .select('*')
            .eq('id', conceptId)
            .single();

        if (conceptError || !concept) {
            return NextResponse.json({ error: 'Concept not found' }, { status: 404 });
        }

        // ── 2. Query Neo4j for KG content ───────────────────────────────
        // conceptId is stored as documentId on Neo4j Concept nodes
        let kgSections = null;

        try {
            const kgResults = await runCypher(
                `MATCH (c:Concept {documentId: $docId})
                 OPTIONAL MATCH (c)-[:EXAMPLES]->(e:Example)
                 OPTIONAL MATCH (c)-[:FORMULAS]->(f:Formula)
                 OPTIONAL MATCH (c)-[:MISCONCEPTIONS]->(m:Misconception)
                 OPTIONAL MATCH (c)-[:EXPLAINS]->(d:Definition)
                 RETURN
                   c.name as name, c.definition as definition,
                   collect(DISTINCT e.text) as examples,
                   collect(DISTINCT f.text) as formulas,
                   collect(DISTINCT m.text) as knownMisconceptions,
                   collect(DISTINCT d.text) as definitions`,
                { docId: conceptId }
            );

            if (kgResults.length > 0) {
                // Merge across all concept nodes for this document
                const allExamples: string[] = [];
                const allFormulas: string[] = [];
                const allKnownMisconceptions: string[] = [];
                const allDefinitions: string[] = [];
                let mainDefinition = '';

                for (const row of kgResults) {
                    const r = row as Record<string, unknown>;
                    if (!mainDefinition && r.definition) {
                        mainDefinition = r.definition as string;
                    }
                    if (Array.isArray(r.examples)) allExamples.push(...(r.examples as string[]).filter(Boolean));
                    if (Array.isArray(r.formulas)) allFormulas.push(...(r.formulas as string[]).filter(Boolean));
                    if (Array.isArray(r.knownMisconceptions)) allKnownMisconceptions.push(...(r.knownMisconceptions as string[]).filter(Boolean));
                    if (Array.isArray(r.definitions)) allDefinitions.push(...(r.definitions as string[]).filter(Boolean));
                }

                // Only use KG path if we actually got useful content
                const hasContent =
                    mainDefinition ||
                    allExamples.length > 0 ||
                    allFormulas.length > 0 ||
                    allDefinitions.length > 0;

                if (hasContent) {
                    kgSections = {
                        definition: mainDefinition || allDefinitions[0] || '',
                        examples: [...new Set(allExamples)],
                        formulas: [...new Set(allFormulas)],
                        knownMisconceptions: [...new Set(allKnownMisconceptions)],
                    };
                }
            }
        } catch (neo4jError) {
            // Non-fatal — fall through to LLM fallback
            console.warn('[Learn] Neo4j query failed, falling back to LLM:', (neo4jError as Error).message);
        }

        // ── 3. Past misconceptions (always fresh, per-user) ─────────────
        const pastMisconceptions = await fetchPastMisconceptions(supabase, userId, conceptId);

        // ── 4a. KG path — return structured content ─────────────────────
        // if (kgSections) {
        //     return NextResponse.json({
        //         success: true,
        //         content: {
        //             title: concept.title,
        //             kgSections,
        //             pastMisconceptions,
        //         },
        //         source: 'kg',
        //     });
        // }

        // ── 4b. Cache lookup for prior LLM generation ───────────────────
        const cached = await lookupCachedLearnContent(supabase, conceptId, grade);
        if (cached) {
            console.log(`[Learn] Cache hit for concept=${conceptId} grade=${grade}`);
            // Await: on Vercel, post-response async work isn't guaranteed to
            // run. The extra ~20ms here is dwarfed by the LLM call we just saved.
            await bumpCacheHit(supabase, conceptId, grade);
            return NextResponse.json({
                success: true,
                content: {
                    ...(cached as Record<string, unknown>),
                    pastMisconceptions,
                },
                source: 'cache',
            });
        }

        // ── 4c. LLM fallback — sparse KG, generate from PDF ─────────────
        console.log(`[Learn] Cache miss — generating for concept=${conceptId} grade=${grade}`);
        const { data: fileData, error: downloadError } = await supabase.storage
            .from('documents')
            .download(concept.source_document);

        if (downloadError || !fileData) {
            console.error('[Learn] Download error:', downloadError);
            return NextResponse.json({ error: 'Failed to load content' }, { status: 500 });
        }

        // Parse PDF/DOCX properly — can't just call .text() on binary files
        const buffer = Buffer.from(await fileData.arrayBuffer());
        let text = '';

        if (concept.source_document.endsWith('.pdf')) {
            const { PDFParse } = await import('pdf-parse');
            const parser = new PDFParse({ data: buffer });
            const pdfData = await parser.getText();
            text = pdfData.text;
            await parser.destroy();
        } else if (concept.source_document.endsWith('.docx')) {
            const mammoth = await import('mammoth');
            const result = await mammoth.extractRawText({ buffer });
            text = result.value;
        } else {
            text = buffer.toString('utf-8'); // plain text fallback
        }

        const truncatedText = text.substring(0, 6000);

        const response = await chatCompletion(
            [
                { role: 'system', content: PROMPTS.LEARN_GUIDE.system(grade) },
                { role: 'user', content: PROMPTS.LEARN_GUIDE.user(concept.title, truncatedText) },
            ],
            { jsonMode: true, maxTokens: 1500 }
        );

        const learnContent = parseLLMJson(response) as Record<string, unknown>;

        // Await: if this drops, the next request re-does the LLM call and we
        // never populate the cache. Writing ~5 KB of JSONB is trivial vs the
        // ~1–3s we just spent on the LLM.
        await storeCachedLearnContent(supabase, conceptId, grade, learnContent);

        return NextResponse.json({
            success: true,
            content: {
                ...learnContent,
                pastMisconceptions, // attach past errors even in LLM fallback
            },
            source: 'llm',
        });

    } catch (error) {
        console.error('[Learn] API error:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}

// ─── Cache helpers ────────────────────────────────────────────────────────

type SupabaseClient = ReturnType<typeof getServiceSupabase>;

/**
 * Return cached learn content if present AND within TTL. Otherwise null.
 * Any DB error is swallowed and treated as a cache miss — the LLM call
 * is then the safety net.
 */
async function lookupCachedLearnContent(
    supabase: SupabaseClient,
    conceptId: string,
    grade: string,
): Promise<Record<string, unknown> | null> {
    try {
        const { data, error } = await supabase
            .from('learn_content_cache')
            .select('content, created_at')
            .eq('concept_id', conceptId)
            .eq('grade', grade)
            .maybeSingle();

        if (error || !data) return null;

        // TTL check — stale rows are ignored (and will be overwritten by the
        // next successful LLM response, so we don't bother deleting here).
        const ageDays = (Date.now() - new Date(data.created_at as string).getTime())
            / (1000 * 60 * 60 * 24);
        if (ageDays > LEARN_CACHE_TTL_DAYS) {
            console.log(`[Learn] Cache stale (${ageDays.toFixed(1)}d > ${LEARN_CACHE_TTL_DAYS}d) — will regenerate`);
            return null;
        }

        return data.content as Record<string, unknown>;
    } catch (err) {
        console.warn('[Learn] Cache lookup threw (treating as miss):', (err as Error).message);
        return null;
    }
}

async function storeCachedLearnContent(
    supabase: SupabaseClient,
    conceptId: string,
    grade: string,
    content: Record<string, unknown>,
): Promise<void> {
    try {
        const { error } = await supabase
            .from('learn_content_cache')
            .upsert(
                {
                    concept_id: conceptId,
                    grade,
                    content,
                    source: 'llm',
                    model: LEARN_GENERATION_MODEL,
                    // created_at is reset on regeneration so the TTL clock
                    // restarts — that's what we want for a fresh generation.
                    created_at: new Date().toISOString(),
                    last_hit_at: new Date().toISOString(),
                    hit_count: 1,
                },
                { onConflict: 'concept_id,grade' },
            );
        if (error) {
            console.warn('[Learn] Cache store error (non-fatal):', error.message);
        }
    } catch (err) {
        console.warn('[Learn] Cache store threw (non-fatal):', (err as Error).message);
    }
}

/**
 * Fire-and-forget update of hit_count and last_hit_at.
 * We read-then-write because Supabase's pg_rest surface doesn't expose
 * `UPDATE ... SET col = col + 1` expressions directly. Cheap enough for
 * a cache hit path.
 */
async function bumpCacheHit(
    supabase: SupabaseClient,
    conceptId: string,
    grade: string,
): Promise<void> {
    try {
        const { data } = await supabase
            .from('learn_content_cache')
            .select('hit_count')
            .eq('concept_id', conceptId)
            .eq('grade', grade)
            .maybeSingle();
        if (!data) return;
        await supabase
            .from('learn_content_cache')
            .update({
                hit_count: ((data.hit_count as number) ?? 0) + 1,
                last_hit_at: new Date().toISOString(),
            })
            .eq('concept_id', conceptId)
            .eq('grade', grade);
    } catch (err) {
        console.warn('[Learn] Hit-count bump failed (non-fatal):', (err as Error).message);
    }
}

// ─── Past misconceptions ──────────────────────────────────────────────────

interface PastMisconception {
    question_text: string;
    selected_answer: string;
    correct_answer: string;
    explanation: string;
    created_at: string;
}

async function fetchPastMisconceptions(
    supabase: SupabaseClient,
    userId: string | null,
    conceptId: string,
): Promise<PastMisconception[]> {
    if (!userId) return [];
    try {
        const { data: incorrectAttempts } = await supabase
            .from('attempts')
            .select('question_text, correct_answer, selected_answer, explanation, created_at')
            .eq('user_id', userId)
            .eq('concept_id', conceptId)
            .eq('correct', false)
            .not('question_text', 'is', null)
            .order('created_at', { ascending: false })
            .limit(10);

        return (incorrectAttempts || []) as PastMisconception[];
    } catch (attemptsError) {
        // Non-fatal
        console.warn('[Learn] Failed to fetch past attempts:', (attemptsError as Error).message);
        return [];
    }
}