import { chatCompletion, parseLLMJson } from './groq';
import { runCypher } from './neo4j';
import { chunkText, generateEmbedding } from './embeddings';
import { ExtractedKnowledge, KnowledgeGraph, ConceptNode, ConceptRelation } from '@/types/concept';
import { v4 as uuid } from 'uuid';

/**
 * Knowledge Graph Builder
 * 
 * Pipeline:
 * 1. Chunk the document text
 * 2. Extract concepts, definitions, relationships from each chunk via LLM
 * 3. Merge and deduplicate extracted knowledge
 * 4. Build Neo4j knowledge graph
 */

// ─── Step 1: Extract knowledge from text chunks ───

import { PROMPTS } from '@/config/prompts';

// ─── Step 1: Extract knowledge from text chunks ───

async function extractKnowledgeFromChunk(chunk: string): Promise<ExtractedKnowledge> {
    // Load exemplars (could be from a file or DB)
    const exemplars = `SciERC Style: 
    { "from": "Neurons", "to": "Signals", "type": "USED_FOR" }
    { "from": "Brain", "to": "Nervous System", "type": "PART_OF" }`;

    const response = await chatCompletion(
        [
            { role: 'system', content: PROMPTS.KG_EXTRACTOR.system },
            { role: 'user', content: PROMPTS.KG_EXTRACTOR.user(chunk, exemplars) },
        ],
        { jsonMode: true, temperature: 0.2 }
    );

    return parseLLMJson<ExtractedKnowledge>(response);
}

// ─── Step 2: Merge extracted knowledge ───

function mergeKnowledge(chunks: ExtractedKnowledge[]): ExtractedKnowledge {
    const conceptMap = new Map<string, any>();
    const relationships: ExtractedKnowledge['relationships'] = [];

    for (const chunk of chunks) {
        for (const concept of chunk.concepts) {
            const key = concept.name.toLowerCase().trim();
            const existing = conceptMap.get(key);

            if (existing) {
                // Generic merge of all properties
                const allKeys = new Set([...Object.keys(existing), ...Object.keys(concept)]);
                for (const prop of allKeys) {
                    if (prop === 'name') continue;

                    const val1 = (existing as any)[prop];
                    const val2 = (concept as any)[prop];

                    if (Array.isArray(val1) || Array.isArray(val2)) {
                        (existing as any)[prop] = [...new Set([...(val1 || []), ...(val2 || [])])];
                    } else if (!val1 && val2) {
                        (existing as any)[prop] = val2;
                    }
                }
            } else {
                conceptMap.set(key, { ...concept });
            }
        }

        // Deduplicate relationships
        for (const rel of chunk.relationships) {
            const exists = relationships.some(
                (r) =>
                    r.from.toLowerCase() === rel.from.toLowerCase() &&
                    r.to.toLowerCase() === rel.to.toLowerCase() &&
                    r.type.toUpperCase() === rel.type.toUpperCase()
            );
            if (!exists) {
                relationships.push(rel);
            }
        }
    }

    return {
        concepts: Array.from(conceptMap.values()),
        relationships,
    };
}

// ─── Step 3: Write to Neo4j ───

async function writeToNeo4j(
    userId: string,
    documentId: string,
    knowledge: ExtractedKnowledge
): Promise<KnowledgeGraph> {
    const nodes: ConceptNode[] = [];
    const relations: ConceptRelation[] = [];

    for (const concept of knowledge.concepts) {
        const conceptId = uuid();

        // Clean properties for Neo4j (no arrays in main node)
        const mainProps: Record<string, string> = {
            id: conceptId,
            name: concept.name,
            definition: concept.definition || '',
            userId,
            documentId
        };

        // 1. Create Main Concept Node
        await runCypher(
            `CREATE (c:Concept {
                id: $id,
                name: $name,
                definition: $definition,
                userId: $userId,
                documentId: $documentId
            })`,
            mainProps
        );

        nodes.push({
            id: conceptId,
            label: concept.name,
            type: 'concept',
            properties: mainProps,
        });

        // 2. Dynamically Create Related Nodes for Lists (examples, formulas, etc.)
        const dynamicProps: Record<string, any> = { ...concept };
        // We want to skip name and definition as they are in the main node
        const SKIP_KEYS = ['name', 'definition'];

        for (const [key, value] of Object.entries(dynamicProps)) {
            if (SKIP_KEYS.includes(key)) continue;

            const relType = key.toUpperCase();
            const items = Array.isArray(value) ? value : [value];

            for (const item of items) {
                if (!item || typeof item !== 'string') continue;

                const subNodeId = uuid();
                const nodeType = key.endsWith('s') ? key.slice(0, -1) : key;

                await runCypher(
                    `MATCH (c:Concept {id: $conceptId})
                     CREATE (s:${nodeType.charAt(0).toUpperCase() + nodeType.slice(1)} {id: $id, text: $text})
                     CREATE (c)-[:${relType}]->(s)`,
                    { conceptId, id: subNodeId, text: item }
                );

                nodes.push({
                    id: subNodeId,
                    label: `${nodeType}: ${item.substring(0, 30)}...`,
                    type: nodeType as any,
                    properties: { text: item }
                });

                relations.push({
                    source: conceptId,
                    target: subNodeId,
                    type: relType as any
                });
            }
        }
    }

    // 3. Create Inter-Concept Relationships (Extracted by AI)
    for (const rel of knowledge.relationships) {
        const dynamicRelType = (rel.type || 'RELATES_TO').toUpperCase().replace(/\s+/g, '_');

        await runCypher(
            `MATCH (a:Concept {userId: $userId}), (b:Concept {userId: $userId})
             WHERE toLower(a.name) = toLower($from) AND toLower(b.name) = toLower($to)
             MERGE (a)-[:${dynamicRelType}]->(b)`,
            {
                userId,
                from: rel.from,
                to: rel.to,
            }
        );
    }

    return { nodes, relations };
}

// ─── Main Builder Function ───

export async function buildKnowledgeGraph(
    userId: string,
    documentId: string,
    text: string
): Promise<KnowledgeGraph> {
    // 1. Chunk the text
    const chunks = chunkText(text);
    console.log(`[KG Builder] Created ${chunks.length} chunks from document`);

    // 2. Extract knowledge from each chunk
    const extractedChunks: ExtractedKnowledge[] = [];
    for (const chunk of chunks) {
        try {
            const knowledge = await extractKnowledgeFromChunk(chunk);
            extractedChunks.push(knowledge);
        } catch (error) {
            console.error('[KG Builder] Failed to extract from chunk:', error);
        }
    }

    // 3. Merge knowledge
    const merged = mergeKnowledge(extractedChunks);
    console.log(
        `[KG Builder] Merged: ${merged.concepts.length} concepts, ${merged.relationships.length} relationships`
    );

    // 4. Write to Neo4j
    const graph = await writeToNeo4j(userId, documentId, merged);
    console.log(`[KG Builder] Knowledge graph created with ${graph.nodes.length} nodes`);

    return graph;
}

/**
 * Query the knowledge graph for a specific concept and its related nodes.
 */
export async function queryConceptGraph(
    userId: string,
    conceptName: string
): Promise<KnowledgeGraph> {
    const results = await runCypher(
        `MATCH (c:Concept {userId: $userId})
     WHERE toLower(c.name) = toLower($name)
     OPTIONAL MATCH (c)-[r]->(related)
     RETURN c, type(r) as relType, related`,
        { userId, name: conceptName }
    );

    const nodes: ConceptNode[] = [];
    const relations: ConceptRelation[] = [];

    for (const record of results) {
        const c = record as Record<string, unknown>;
        const concept = c.c as Record<string, unknown>;
        const conceptProps = (concept as { properties?: Record<string, string> })?.properties || {};

        if (!nodes.find((n) => n.id === conceptProps.id)) {
            nodes.push({
                id: conceptProps.id || '',
                label: conceptProps.name || '',
                type: 'concept',
                properties: conceptProps,
            });
        }

        if (c.related) {
            const related = c.related as { properties?: Record<string, string> };
            const relatedProps = related.properties || {};
            nodes.push({
                id: relatedProps.id || '',
                label: relatedProps.name || relatedProps.text || '',
                type: 'definition',
                properties: relatedProps,
            });
            relations.push({
                source: conceptProps.id || '',
                target: relatedProps.id || '',
                type: (c.relType as ConceptRelation['type']) || 'EXPLAINS',
            });
        }
    }

    return { nodes, relations };
}

/**
 * Get all concepts for a user from Neo4j.
 */
export async function getUserConcepts(userId: string): Promise<ConceptNode[]> {
    const results = await runCypher(
        `MATCH (c:Concept {userId: $userId}) RETURN c`,
        { userId }
    );

    return results.map((record) => {
        const r = record as Record<string, unknown>;
        const c = r.c as { properties?: Record<string, string> };
        const props = c.properties || {};
        return {
            id: props.id || '',
            label: props.name || '',
            type: 'concept' as const,
            properties: props,
        };
    });
}
