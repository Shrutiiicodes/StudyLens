import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase';
import { runCypher } from '@/lib/neo4j';
import { chatCompletion, parseLLMJson } from '@/lib/groq';
import { PROMPTS } from '@/config/prompts';

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

        // ── 3. Query Supabase for past incorrect attempts ───────────────
        let pastMisconceptions: Array<{
            question_text: string;
            selected_answer: string;
            correct_answer: string;
            explanation: string;
            created_at: string;
        }> = [];

        if (userId) {
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

                pastMisconceptions = (incorrectAttempts || []) as typeof pastMisconceptions;
            } catch (attemptsError) {
                // Non-fatal
                console.warn('[Learn] Failed to fetch past attempts:', (attemptsError as Error).message);
            }
        }

        // ── 4a. KG path — return structured content ─────────────────────
        if (kgSections) {
            return NextResponse.json({
                success: true,
                content: {
                    title: concept.title,
                    kgSections,
                    pastMisconceptions,
                },
                source: 'kg',
            });
        }

        // ── 4b. LLM fallback — sparse KG, generate from PDF ─────────────
        const { data: fileData, error: downloadError } = await supabase.storage
            .from('documents')
            .download(concept.source_document);

        if (downloadError || !fileData) {
            console.error('[Learn] Download error:', downloadError);
            return NextResponse.json({ error: 'Failed to load content' }, { status: 500 });
        }

        const text = await fileData.text();
        const truncatedText = text.substring(0, 15000);

        const response = await chatCompletion(
            [
                { role: 'system', content: PROMPTS.LEARN_GUIDE.system(grade) },
                { role: 'user', content: PROMPTS.LEARN_GUIDE.user(concept.title, truncatedText) },
            ],
            { jsonMode: true }
        );

        const learnContent = parseLLMJson(response);

        return NextResponse.json({
            success: true,
            content: {
                ...(learnContent as Record<string, unknown>),
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