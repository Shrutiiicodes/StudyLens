import { NextRequest, NextResponse } from 'next/server';
import { runCypher } from '@/lib/neo4j';

/**
 * GET /api/graph?conceptId=xxx&userId=xxx
 * Get knowledge graph data for a concept from Neo4j.
 */
export async function GET(request: NextRequest) {
    try {
        const conceptId = request.nextUrl.searchParams.get('conceptId');
        const userId = request.nextUrl.searchParams.get('userId');

        if (!userId) {
            return NextResponse.json({ error: 'userId is required' }, { status: 400 });
        }

        // Fetch all concept nodes and related nodes for this document
        const results = await runCypher(
            `MATCH (c:Concept {userId: $userId, documentId: $documentId})
             OPTIONAL MATCH (c)-[r]->(related)
             RETURN c, type(r) as relType, related`,
            { userId, documentId: conceptId }
        );

        const nodes: Array<{ id: string; label: string; type: string; properties?: Record<string, string> }> = [];
        const edges: Array<{ source: string; target: string; type: string }> = [];
        const seenNodes = new Set<string>();

        for (const record of results) {
            const r = record as Record<string, unknown>;
            const concept = r.c as { properties?: Record<string, string> };
            const conceptProps = concept?.properties || {};

            if (conceptProps.id && !seenNodes.has(conceptProps.id)) {
                seenNodes.add(conceptProps.id);
                nodes.push({
                    id: conceptProps.id,
                    label: conceptProps.name || '',
                    type: 'concept',
                    properties: conceptProps,
                });
            }

            if (r.related) {
                const related = r.related as { properties?: Record<string, string> };
                const relatedProps = related?.properties || {};
                if (relatedProps.id && !seenNodes.has(relatedProps.id)) {
                    seenNodes.add(relatedProps.id);
                    const relType = (r.relType as string) || 'EXPLAINS';
                    let nodeType = 'definition';
                    if (relType === 'HAS_EXAMPLE') nodeType = 'example';
                    else if (relType === 'CAUSES_CONFUSION_WITH') nodeType = 'misconception';
                    else if (relType === 'PREREQUISITE') nodeType = 'concept';

                    nodes.push({
                        id: relatedProps.id,
                        label: relatedProps.name || relatedProps.text || '',
                        type: nodeType,
                        properties: relatedProps,
                    });
                }

                if (conceptProps.id && relatedProps.id) {
                    edges.push({
                        source: conceptProps.id,
                        target: relatedProps.id,
                        type: (r.relType as string) || 'EXPLAINS',
                    });
                }
            }
        }

        return NextResponse.json({
            success: true,
            nodes,
            edges,
        });
    } catch (error) {
        console.error('Graph API error:', error);
        return NextResponse.json({
            success: true,
            nodes: [],
            edges: [],
        });
    }
}
