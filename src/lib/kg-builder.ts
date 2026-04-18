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

            // Allow directly stated (a) OR strongly implied (b) with relaxed threshold
            // to prevent over-discarding and orphan nodes
            const isValid =
                (result.verdict === 'a' && result.confidence >= 0.65) ||
                (result.verdict === 'b' && result.confidence >= 0.80);

            if (isValid) {
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
        _sourceChunk: chunk,
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

/**
 * Normalizes a concept name to a canonical form for deduplication.
 * Strips punctuation, collapses whitespace, lowercases, and removes
 * common trailing noise words that the LLM adds inconsistently.
 */
function canonicalizeName(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')        // strip punctuation
        .replace(/\b(the|a|an|of|and|in|on|process|concept|principle|phenomenon|theory|law|effect|method|system|type|form|kind|class|category)\b/g, '')
        .replace(/\s+/g, ' ')               // collapse whitespace
        .trim();
}

function mergeKnowledge(chunks: Array<ExtractedKnowledge & { _sourceChunk?: string }>): ExtractedKnowledge & { _sourceChunk: string } {
    // Maps canonical key → concept, preserving original name from first occurrence
    const conceptMap = new Map<string, any>();
    const relationships: ExtractedKnowledge['relationships'] = [];

    for (const chunk of chunks) {
        for (const concept of chunk.concepts) {
            const key = canonicalizeName(concept.name);
            if (!key) continue; // skip empty after normalization

            const existing = conceptMap.get(key);

            if (existing) {
                // Generic merge of all properties
                const allKeys = new Set([...Object.keys(existing), ...Object.keys(concept)]);
                for (const prop of allKeys) {
                    if (prop === 'name') continue; // keep name from first occurrence

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
        // Fix 1: Filter self-loops (from === to after normalization)
        // Fix 3: Prevent bidirectional edges of the same type (only keep first direction)
        for (const rel of chunk.relationships) {
            const fromNorm = rel.from.toLowerCase().trim();
            const toNorm = rel.to.toLowerCase().trim();
            const typeNorm = rel.type.toUpperCase();

            // Fix 1: Drop self-loops
            if (canonicalizeName(rel.from) === canonicalizeName(rel.to)) {
                console.log(`[KG Merge] Dropped self-loop: (${rel.from}, ${rel.type}, ${rel.to})`);
                continue;
            }

            // Check for exact duplicate (same direction)
            const exactDuplicate = relationships.some(
                (r) =>
                    r.from.toLowerCase() === fromNorm &&
                    r.to.toLowerCase() === toNorm &&
                    r.type.toUpperCase() === typeNorm
            );

            // Fix 3: Check for bidirectional duplicate of the same type
            const bidirectionalDuplicate = relationships.some(
                (r) =>
                    r.from.toLowerCase() === toNorm &&
                    r.to.toLowerCase() === fromNorm &&
                    r.type.toUpperCase() === typeNorm
            );

            if (!exactDuplicate && !bidirectionalDuplicate) {
                relationships.push(rel);
            } else if (bidirectionalDuplicate) {
                console.log(`[KG Merge] Dropped bidirectional duplicate: (${rel.from}, ${rel.type}, ${rel.to})`);
            }
        }
    }

    return {
        concepts: Array.from(conceptMap.values()),
        relationships,
        _sourceChunk: chunks[0]?._sourceChunk || '',
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

// ─── Step 2b: Cross-chunk linking (Fix 4 — density / orphan nodes) ───

/**
 * Finds Concept nodes for this document that have zero relationships and
 * attempts to link them to other concepts via the LLM.
 *
 * This resolves the "very low average degree" issue that arises because
 * the per-chunk extractor only sees one chunk at a time, so cross-chunk
 * relationships are never found.
 *
 * Strategy:
 *  1. Query Neo4j for orphan Concept nodes (degree = 0) in this document.
 *  2. Also fetch a sample of well-connected concepts as candidates.
 *  3. For each orphan, ask the LLM: "given this concept's definition,
 *     which of these candidates is it related to, and how?"
 *  4. Write RELATES_TO (or the suggested type) edges for confident pairs.
 */
async function linkOrphanConcepts(userId: string, documentId: string): Promise<void> {
    // 1. Find orphan concept nodes (no inbound or outbound edges in the whole graph for this user)
    const orphans = await runCypher<{ id: string; name: string; definition: string }>(
        `MATCH (c:Concept {userId: $userId, documentId: $docId})
         WHERE NOT (c)--()
         RETURN c.id AS id, c.name AS name, c.definition AS definition
         LIMIT 50`,
        { userId, docId: documentId }
    );

    if (orphans.length === 0) {
        console.log('[KG Link] No orphan concepts found — skipping cross-chunk link pass');
        return;
    }

    console.log(`[KG Link] Found ${orphans.length} orphan concept(s) — attempting to link`);

    // 2. Fetch candidate concepts (connected ones to link against)
    const candidates = await runCypher<{ id: string; name: string; definition: string }>(
        `MATCH (c:Concept {userId: $userId, documentId: $docId})
         WHERE (c)--()
         RETURN c.id AS id, c.name AS name, c.definition AS definition
         LIMIT 50`,
        { userId, docId: documentId }
    );

    if (candidates.length === 0) {
        console.log('[KG Link] No candidate concepts to link orphans against');
        return;
    }

    const candidateSummary = candidates
        .map((c) => `- ${c.name}: ${c.definition || 'no definition'}`)
        .join('\n');

    // 3. For each orphan, ask the LLM which candidates it relates to
    for (const orphan of orphans) {
        try {
            const response = await chatCompletion(
                [
                    {
                        role: 'system',
                        content: `You are an educational knowledge graph assistant.
Given an orphan concept and a list of candidate concepts, identify which candidates
are meaningfully related to the orphan and emit up to 3 relationships.

Only emit relationships that are clearly meaningful for a CBSE Grade 4–10 student.
Use relationship types: IS_A | CAUSES | REQUIRES | PART_OF | CONTRASTS_WITH | EXAMPLE_OF | USED_FOR | FEATURE_OF | PRECEDES | EXTENSION_OF | RELATES_TO

Respond ONLY with JSON:
{
  "relationships": [
    { "to": "candidate concept name", "type": "RELATION_TYPE", "confidence": 0.0–1.0 }
  ]
}`
                    },
                    {
                        role: 'user',
                        content: `Orphan concept: "${orphan.name}"
Definition: "${orphan.definition || 'not available'}"

Candidate concepts:
${candidateSummary}

Which candidates is "${orphan.name}" related to, and how?`
                    }
                ],
                { jsonMode: true, temperature: 0.2 }
            );

            const result = parseLLMJson<{ relationships: Array<{ to: string; type: string; confidence: number }> }>(response);

            for (const rel of result.relationships || []) {
                if (!rel.to || !rel.type || rel.confidence < 0.55) continue;

                // Guard: skip self-loops
                if (rel.to.toLowerCase().trim() === orphan.name.toLowerCase().trim()) continue;

                const relType = rel.type.toUpperCase().replace(/\s+/g, '_');

                await runCypher(
                    `MATCH (a:Concept {id: $fromId}), (b:Concept {userId: $userId})
                     WHERE toLower(b.name) = toLower($toName)
                     AND a.id <> b.id
                     AND NOT (a)-[:${relType}]->(b)
                     MERGE (a)-[:${relType}]->(b)`,
                    { fromId: orphan.id, userId, toName: rel.to }
                );

                console.log(`[KG Link] Linked orphan "${orphan.name}" -[${relType}]-> "${rel.to}" (confidence: ${rel.confidence})`);
            }
        } catch (err) {
            console.warn(`[KG Link] Failed to link orphan "${orphan.name}":`, err);
        }
    }
}

async function linkOrphansAcrossDocuments(
    userId: string,
    documentId: string
): Promise<void> {
    // Re-check: are there still orphans in this document?
    const orphans = await runCypher<{ id: string; name: string; definition: string }>(
        `MATCH (c:Concept {userId: $userId, documentId: $docId})
         WHERE NOT (c)--()
         RETURN c.id AS id, c.name AS name, c.definition AS definition
         LIMIT 40`,
        { userId, docId: documentId }
    );

    if (orphans.length === 0) {
        console.log('[KG CrossLink] No orphans remain after per-document pass — skipping');
        return;
    }

    // Fetch well-connected concepts from OTHER documents by this user
    const candidates = await runCypher<{ id: string; name: string; definition: string }>(
        `MATCH (c:Concept {userId: $userId})
         WHERE c.documentId <> $docId AND (c)--()
         RETURN c.id AS id, c.name AS name, c.definition AS definition
         LIMIT 50`,
        { userId, docId: documentId }
    );

    if (candidates.length === 0) {
        console.log('[KG CrossLink] No inter-document candidates found — user has only 1 document');
        return;
    }

    console.log(
        `[KG CrossLink] Linking ${orphans.length} orphan(s) against ${candidates.length} cross-document candidate(s)`
    );

    const candidateSummary = candidates
        .map((c) => `- ${c.name}: ${(c.definition || '').substring(0, 100)}`)
        .join('\n');

    for (const orphan of orphans) {
        try {
            const response = await chatCompletion(
                [
                    {
                        role: 'system',
                        content: `You are an educational knowledge graph assistant for CBSE Grade 4–10.
Given an orphan concept and a list of candidate concepts from related study documents,
identify which candidates are meaningfully related to the orphan and suggest up to 3 relationships.
 
Only emit relationships that are clearly meaningful for a CBSE student.
Use types: IS_A | CAUSES | REQUIRES | PART_OF | CONTRASTS_WITH | EXAMPLE_OF | USED_FOR | FEATURE_OF | PRECEDES | EXTENSION_OF | RELATES_TO
 
Respond ONLY with JSON: { "relationships": [{ "to": "name", "type": "TYPE", "confidence": 0.0-1.0 }] }`,
                    },
                    {
                        role: 'user',
                        content: `Orphan concept: "${orphan.name}"
Definition: "${orphan.definition || 'not available'}"
 
Cross-document candidates:
${candidateSummary}
 
Which candidates is "${orphan.name}" related to?`,
                    },
                ],
                { jsonMode: true, temperature: 0.2 }
            );

            const result = parseLLMJson<{
                relationships: Array<{ to: string; type: string; confidence: number }>;
            }>(response);

            for (const rel of result.relationships || []) {
                if (!rel.to || !rel.type || rel.confidence < 0.55) continue;
                if (rel.to.toLowerCase().trim() === orphan.name.toLowerCase().trim()) continue;

                const relType = rel.type.toUpperCase().replace(/\s+/g, '_');

                await runCypher(
                    `MATCH (a:Concept {id: $fromId}), (b:Concept {userId: $userId})
                     WHERE toLower(b.name) = toLower($toName)
                     AND a.id <> b.id
                     AND NOT (a)-[:${relType}]->(b)
                     MERGE (a)-[:${relType}]->(b)`,
                    { fromId: orphan.id, userId, toName: rel.to }
                );

                console.log(
                    `[KG CrossLink] ${orphan.name} -[${relType}]-> ${rel.to} (conf: ${rel.confidence})`
                );
            }
        } catch (err) {
            console.warn(`[KG CrossLink] Failed for orphan "${orphan.name}":`, err);
        }
    }
}

// ─── CBSE subject domains used as anchor nodes ───
const CBSE_DOMAINS = [
    { name: 'Mathematics', keywords: ['equation', 'number', 'geometry', 'algebra', 'fraction', 'ratio', 'area', 'volume', 'angle', 'polygon', 'prime', 'integer', 'decimal', 'percentage'] },
    { name: 'Science', keywords: ['force', 'motion', 'energy', 'matter', 'cell', 'organism', 'chemical', 'element', 'atom', 'molecule', 'magnet', 'light', 'sound', 'heat', 'electricity', 'gravity', 'photosynthesis', 'ecosystem'] },
    { name: 'Social Studies', keywords: ['history', 'geography', 'civics', 'government', 'constitution', 'trade', 'culture', 'river', 'mountain', 'continent', 'empire', 'dynasty', 'democracy', 'resources', 'climate', 'map', 'soil'] },
    { name: 'English', keywords: ['grammar', 'verb', 'noun', 'adjective', 'adverb', 'tense', 'sentence', 'paragraph', 'comprehension', 'vocabulary', 'synonym', 'antonym', 'pronoun', 'preposition'] },
    { name: 'Hindi', keywords: ['संज्ञा', 'क्रिया', 'विशेषण', 'वाक्य', 'व्याकरण', 'काल'] },
    { name: 'Computer Science', keywords: ['algorithm', 'program', 'variable', 'loop', 'function', 'data', 'network', 'internet', 'software', 'hardware', 'binary', 'database'] },
];

/**
 * Anchors still-orphan concepts to the most relevant CBSE subject-domain
 * :SubjectDomain node.  This is a last-resort pass that guarantees every
 * concept has at least one edge, eliminating the "orphan node" metric.
 *
 * SubjectDomain nodes are shared (no userId) so they act as a common
 * vocabulary across all students.
 */
async function anchorOrphansToSubjectDomain(
    userId: string,
    documentId: string
): Promise<void> {
    const orphans = await runCypher<{ id: string; name: string; definition: string }>(
        `MATCH (c:Concept {userId: $userId, documentId: $docId})
         WHERE NOT (c)--()
         RETURN c.id AS id, c.name AS name, c.definition AS definition`,
        { userId, docId: documentId }
    );

    if (orphans.length === 0) return;

    console.log(`[KG Anchor] ${orphans.length} orphan(s) remaining — anchoring to subject domains`);

    for (const orphan of orphans) {
        const text = `${orphan.name} ${orphan.definition || ''}`.toLowerCase();

        // Score each domain by keyword hits
        let bestDomain = 'General Knowledge';
        let bestScore = 0;

        for (const domain of CBSE_DOMAINS) {
            const score = domain.keywords.filter((kw) => text.includes(kw)).length;
            if (score > bestScore) {
                bestScore = score;
                bestDomain = domain.name;
            }
        }

        try {
            // Upsert the SubjectDomain node (no userId — shared across students)
            await runCypher(
                `MERGE (d:SubjectDomain {name: $domain})
                 WITH d
                 MATCH (c:Concept {id: $conceptId})
                 MERGE (c)-[:PART_OF]->(d)`,
                { domain: bestDomain, conceptId: orphan.id }
            );
            console.log(`[KG Anchor] "${orphan.name}" -[PART_OF]-> "${bestDomain}"`);
        } catch (err) {
            console.warn(`[KG Anchor] Failed to anchor "${orphan.name}":`, err);
        }
    }
}

// ─── Step 3: Write to Neo4j ───

async function writeToNeo4j(
    userId: string,
    documentId: string,
    knowledge: ExtractedKnowledge & { _sourceChunk?: string }
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
            documentId,
            sourceChunk: (knowledge._sourceChunk || '').substring(0, 500),
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
        const fromNorm = rel.from.toLowerCase().trim();
        const toNorm = rel.to.toLowerCase().trim();

        // Final self-loop guard at write time (belt-and-suspenders)
        if (fromNorm === toNorm) {
            console.log(`[KG Write] Skipped self-loop: (${rel.from}, ${rel.type}, ${rel.to})`);
            continue;
        }

        const dynamicRelType = (rel.type || 'RELATES_TO').toUpperCase().replace(/\s+/g, '_');

        await runCypher(
            `MATCH (a:Concept {userId: $userId}), (b:Concept {userId: $userId})
             WHERE toLower(a.name) = toLower($from) AND toLower(b.name) = toLower($to)
             AND a.id <> b.id
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

    // 6. Cross-chunk linking pass — connect related concepts that were extracted
    //    in different chunks and therefore have no explicit relationship yet.
    //    This addresses the low-density / orphan node problem.
    try {
        await linkOrphanConcepts(userId, documentId);
    } catch (linkError) {
        console.error('[KG Builder] Cross-chunk linking error (non-fatal):', linkError);
    }
    try {
        await linkOrphansAcrossDocuments(userId, documentId);
    } catch (crossLinkError) {
        console.error('[KG Builder] Cross-document linking error (non-fatal):', crossLinkError);
    }
    try {
        await anchorOrphansToSubjectDomain(userId, documentId);
    } catch (anchorError) {
        console.error('[KG Builder] Subject-domain anchoring error (non-fatal):', anchorError);
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