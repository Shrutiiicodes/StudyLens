import { NextRequest, NextResponse } from 'next/server';
import { runCypher } from '@/lib/neo4j';
export const maxDuration = 60;
export const runtime = 'nodejs';
/**
 * GET /api/concepts/tag?userId=xxx
 *
 * Backfills `subjectDomain` on every Concept node that doesn't already have
 * one, using keyword matching on name + definition.
 *
 * Safe to call multiple times (idempotent — skips nodes that already have
 * a subjectDomain).
 *
 * Also used by the upload pipeline — call after buildKnowledgeGraph():
 *   await fetch(`/api/concepts/tag?userId=${userId}`, { method: 'GET' });
 *
 * Response:
 *   { success: true, tagged: N, already_tagged: M }
 */

const CBSE_DOMAINS: Array<{ name: string; keywords: string[] }> = [
    {
        name: 'Mathematics',
        keywords: [
            'equation', 'number', 'geometry', 'algebra', 'fraction', 'ratio',
            'area', 'volume', 'angle', 'polygon', 'prime', 'integer', 'decimal',
            'percentage', 'triangle', 'circle', 'coordinate', 'probability',
            'statistics', 'matrix', 'quadratic', 'linear', 'calculus',
        ],
    },
    {
        name: 'Science',
        keywords: [
            'force', 'motion', 'energy', 'matter', 'cell', 'organism', 'chemical',
            'element', 'atom', 'molecule', 'magnet', 'light', 'sound', 'heat',
            'electricity', 'gravity', 'photosynthesis', 'ecosystem', 'nutrition',
            'respiration', 'reproduction', 'evolution', 'genetics', 'reaction',
            'acid', 'base', 'salt', 'metal', 'wave', 'current', 'voltage',
            'nucleus', 'tissue', 'organ', 'pressure', 'density',
        ],
    },
    {
        name: 'Social Studies',
        keywords: [
            'history', 'geography', 'civics', 'government', 'constitution', 'trade',
            'culture', 'river', 'mountain', 'continent', 'empire', 'dynasty',
            'democracy', 'resources', 'climate', 'map', 'soil', 'election',
            'parliament', 'president', 'rights', 'law', 'agriculture', 'industry',
            'independence', 'colony', 'revolution', 'treaty', 'migration',
            'census', 'latitude', 'longitude', 'vegetation',
        ],
    },
    {
        name: 'English',
        keywords: [
            'grammar', 'verb', 'noun', 'adjective', 'adverb', 'tense', 'sentence',
            'paragraph', 'comprehension', 'vocabulary', 'synonym', 'antonym',
            'pronoun', 'preposition', 'conjunction', 'punctuation', 'essay',
            'narrative', 'poem', 'story', 'character', 'plot', 'theme',
        ],
    },
    {
        name: 'Computer Science',
        keywords: [
            'algorithm', 'program', 'variable', 'loop', 'function', 'data',
            'network', 'internet', 'software', 'hardware', 'binary', 'database',
            'array', 'class', 'object', 'recursion', 'sorting', 'operating system',
            'compiler', 'spreadsheet', 'html', 'cpu', 'memory',
        ],
    },
    {
        name: 'Hindi',
        keywords: [
            'संज्ञा', 'क्रिया', 'विशेषण', 'वाक्य', 'व्याकरण', 'काल',
            'संधि', 'समास', 'उपसर्ग', 'प्रत्यय', 'निबंध', 'कहानी',
        ],
    },
];

function inferDomain(name: string, definition: string): string {
    const text = `${name} ${definition}`.toLowerCase();
    let bestDomain = 'General Knowledge';
    let bestScore = 0;

    for (const domain of CBSE_DOMAINS) {
        const score = domain.keywords.filter((kw) => text.includes(kw)).length;
        if (score > bestScore) {
            bestScore = score;
            bestDomain = domain.name;
        }
    }

    return bestDomain;
}

export async function GET(request: NextRequest) {
    try {
        const userId = request.nextUrl.searchParams.get('userId');
        if (!userId) {
            return NextResponse.json({ error: 'userId is required' }, { status: 400 });
        }

        // 1. Fetch concepts that don't yet have a subjectDomain
        const untagged = await runCypher<{
            id: string;
            name: string;
            definition: string;
        }>(
            `MATCH (c:Concept {userId: $userId})
             WHERE c.subjectDomain IS NULL OR c.subjectDomain = ''
             RETURN c.id AS id, c.name AS name, c.definition AS definition`,
            { userId }
        );

        // 2. Count already-tagged concepts (for the response)
        const alreadyTaggedResult = await runCypher<{ count: number }>(
            `MATCH (c:Concept {userId: $userId})
             WHERE c.subjectDomain IS NOT NULL AND c.subjectDomain <> ''
             RETURN count(c) AS count`,
            { userId }
        );
        const alreadyTagged = Number(alreadyTaggedResult[0]?.count ?? 0);

        if (untagged.length === 0) {
            return NextResponse.json({
                success: true,
                tagged: 0,
                already_tagged: alreadyTagged,
                message: 'All concepts already have a subject domain.',
            });
        }

        // 3. Tag each untagged concept
        let taggedCount = 0;

        for (const concept of untagged) {
            const domain = inferDomain(concept.name, concept.definition || '');

            await runCypher(
                `MATCH (c:Concept {id: $id})
                 SET c.subjectDomain = $domain`,
                { id: concept.id, domain }
            );

            taggedCount++;
        }

        return NextResponse.json({
            success: true,
            tagged: taggedCount,
            already_tagged: alreadyTagged,
        });
    } catch (error) {
        console.error('[ConceptTag] Error:', error);
        return NextResponse.json({ error: 'Failed to tag concepts' }, { status: 500 });
    }
}