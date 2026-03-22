import { chatCompletion, parseLLMJson } from './groq';
import { runCypher } from './neo4j';
import { chunkText, generateEmbedding } from './embeddings';
import { ExtractedKnowledge, KnowledgeGraph, ConceptNode, ConceptRelation } from '@/types/concept';
import { v4 as uuid } from 'uuid';
import { PROMPTS } from '@/config/prompts';

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

async function extractKnowledgeFromChunk(chunk: string): Promise<ExtractedKnowledge> {
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

    const raw = parseLLMJson<ExtractedKnowledge>(response);

    // Verify each relationship against the source chunk
    const verifiedRelationships: ExtractedKnowledge['relationships'] = [];

    for (const rel of raw.relationships) {
        try {
            const verifyResponse = await chatCompletion(
                [
                    {
                        role: 'system',
                        content: `You are a fact-verification assistant for educational content.
Given a source passage and a factual triple, determine if the triple is
directly and explicitly supported by the passage.

Respond ONLY with JSON: {"verdict": "a" | "b" | "c", "confidence": 0.0-1.0}

Verdicts:
(a) Directly and explicitly stated in the passage
(b) Implied or inferred — not directly stated
(c) Not supported or contradicted`
                    },
                    {
                        role: 'user',
                        content: `Passage: "${chunk}"

Triple to verify: (${rel.from}, ${rel.type}, ${rel.to})

Is this triple directly supported by the passage?`
                    }
                ],
                { jsonMode: true, temperature: 0.1 }
            );

            const result = parseLLMJson<{ verdict: string; confidence: number }>(verifyResponse);

            if (result.verdict === 'a' && result.confidence >= 0.80) {
                verifiedRelationships.push(rel);
            } else {
                console.log(`[KG Verify] Discarded: (${rel.from}, ${rel.type}, ${rel.to}) — verdict=${result.verdict}, confidence=${result.confidence}`);
            }
        } catch (err) {
            // If verification call fails, discard the triple to be safe
            console.warn(`[KG Verify] Verification failed for triple, discarding:`, rel, err);
        }
    }

    return {
        ...raw,
        relationships: verifiedRelationships,
    };
}

async function verifyTriple(
    triple: { subject: string; predicate: string; object: string },
    sourceChunk: string
): Promise<{ keep: boolean; confidence: number }> {
    const response = await chatCompletion([
        {
            role: 'system',
            content: `You are a fact-verification assistant for educational content.
Given a source passage and a factual triple, determine if the triple is 
directly and explicitly supported by the passage.

Respond ONLY with JSON:
{"verdict": "a" | "b" | "c", "confidence": 0.0-1.0}

Verdicts:
(a) Directly and explicitly stated in the passage
(b) Implied or inferred — not directly stated  
(c) Not supported or contradicted`
        },
        {
            role: 'user',
            content: `Passage: "${sourceChunk}"

Triple to verify: (${triple.subject}, ${triple.predicate}, ${triple.object})

Is this triple directly supported by the passage?`
        }
    ], { jsonMode: true, temperature: 0.1 });

    try {
        const result = parseLLMJson<{ verdict: string; confidence: number }>(response);
        return {
            keep: result.verdict === 'a' && result.confidence >= 0.80,
            confidence: result.confidence
        };
    } catch {
        return { keep: false, confidence: 0 };
    }
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

/**
 * Validates the prerequisite DAG for a document.
 * Detects cycles in REQUIRES + IS_A edges and removes the lowest-confidence
 * edge in each cycle to ensure the graph remains a valid DAG.
 */
async function validatePrerequisiteDAG(
    userId: string,
    documentId: string
): Promise<void> {
    // Fetch all REQUIRES and IS_A edges for this document's concepts
    const edges = await runCypher<{ fromId: string; toId: string; relType: string }>(
        `MATCH (a:Concept {userId: $userId, documentId: $docId})-[r:REQUIRES|IS_A]->(b:Concept {userId: $userId})
         RETURN a.id AS fromId, b.id AS toId, type(r) AS relType`,
        { userId, docId: documentId }
    );

    if (edges.length === 0) {
        console.log('[DAG] No prerequisite edges found — skipping validation');
        return;
    }

    // Build adjacency list
    const graph = new Map<string, string[]>();
    for (const edge of edges) {
        if (!graph.has(edge.fromId)) graph.set(edge.fromId, []);
        graph.get(edge.fromId)!.push(edge.toId);
    }

    // DFS-based cycle detection
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const cyclicEdges: Array<{ from: string; to: string }> = [];

    function dfs(node: string): void {
        visited.add(node);
        inStack.add(node);

        for (const neighbor of graph.get(node) || []) {
            if (!visited.has(neighbor)) {
                dfs(neighbor);
            } else if (inStack.has(neighbor)) {
                // Cycle detected — record the back edge
                cyclicEdges.push({ from: node, to: neighbor });
            }
        }

        inStack.delete(node);
    }

    for (const node of graph.keys()) {
        if (!visited.has(node)) dfs(node);
    }

    if (cyclicEdges.length === 0) {
        console.log(`[DAG] Valid — no cycles found in ${edges.length} prerequisite edges`);
        return;
    }

    console.log(`[DAG] Found ${cyclicEdges.length} cyclic edge(s) — removing`);

    // Remove each cyclic edge from Neo4j
    for (const edge of cyclicEdges) {
        try {
            await runCypher(
                `MATCH (a:Concept {id: $fromId})-[r:REQUIRES|IS_A]->(b:Concept {id: $toId})
                 DELETE r`,
                { fromId: edge.from, toId: edge.to }
            );
            console.log(`[DAG] Removed cyclic edge: ${edge.from} → ${edge.to}`);
        } catch (err) {
            console.error(`[DAG] Failed to remove edge ${edge.from} → ${edge.to}:`, err);
        }
    }
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

        // 2. Create sub-nodes for examples, formulas, misconceptions
        const CONCEPT_ARRAY_FIELDS = ['examples', 'formulas', 'misconceptions'] as const;

        for (const field of CONCEPT_ARRAY_FIELDS) {
            const items = (concept as any)[field] as string[] | undefined;
            if (!items?.length) continue;

            const relType = field.toUpperCase(); // EXAMPLES, FORMULAS, MISCONCEPTIONS
            const nodeLabel = field.slice(0, -1); // example, formula, misconception
            const capitalLabel = nodeLabel.charAt(0).toUpperCase() + nodeLabel.slice(1);

            for (const item of items) {
                if (!item || typeof item !== 'string') continue;
                const subNodeId = uuid();
                await runCypher(
                    `MATCH (c:Concept {id: $conceptId})
                     CREATE (s:${capitalLabel} {id: $id, text: $text})
                     CREATE (c)-[:${relType}]->(s)`,
                    { conceptId, id: subNodeId, text: item }
                );

                nodes.push({
                    id: subNodeId,
                    label: `${nodeLabel}: ${item.substring(0, 30)}...`,
                    type: nodeLabel as any,
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

    // 5. Validate prerequisite DAG — detect and remove cyclic edges
    try {
        await validatePrerequisiteDAG(userId, documentId);
    } catch (dagError) {
        // DAG validation failure should not block the upload
        console.error('[KG Builder] DAG validation error (non-fatal):', dagError);
    }

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