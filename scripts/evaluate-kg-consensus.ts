#!/usr/bin/env tsx
/**
 * ═══════════════════════════════════════════════════════════════
 * STUDY LENS — LLM Consensus KG Quality Evaluator
 * ═══════════════════════════════════════════════════════════════
 *
 * Proxy gold-standard evaluation without an external KG.
 *
 * Strategy:
 *   Run each sampled chunk through the extraction LLM N times
 *   (different temperatures) and measure:
 *     • Concept agreement: how many concepts appear in ≥ 2/3 runs
 *     • Relation agreement: how many triples appear in ≥ 2/3 runs
 *     • Jaccard similarity between run pairs
 *
 *  High disagreement = low extraction reliability = needs tuning.
 *  High agreement   = stable, trustworthy extraction.
 *
 * Usage:
 *   npx tsx scripts/evaluate-kg-consensus.ts
 *   npx tsx scripts/evaluate-kg-consensus.ts --userId=<uuid>
 *   npx tsx scripts/evaluate-kg-consensus.ts --chunks=10 --runs=3
 *
 * ═══════════════════════════════════════════════════════════════
 */

import neo4j from 'neo4j-driver';
import Groq from 'groq-sdk';
import * as fs from 'fs';
import * as path from 'path';

// ── Load .env.local ──────────────────────────────────────────
function loadEnv() {
    const envPath = path.join(__dirname, '..', '.env.local');
    if (!fs.existsSync(envPath)) {
        console.error('.env.local not found');
        process.exit(1);
    }
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.substring(0, eq).trim();
        const val = trimmed.substring(eq + 1).trim();
        if (!process.env[key]) process.env[key] = val;
    }
}
loadEnv();

// ── CLI args ─────────────────────────────────────────────────
const args = process.argv.slice(2);
const userId = args.find((a) => a.startsWith('--userId='))?.split('=')[1];
const chunkSample = parseInt(args.find((a) => a.startsWith('--chunks='))?.split('=')[1] || '8', 10);
const runsPerChunk = parseInt(args.find((a) => a.startsWith('--runs='))?.split('=')[1] || '3', 10);

// ── Colors ───────────────────────────────────────────────────
const C = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    cyan: '\x1b[36m', magenta: '\x1b[35m',
};

function header(msg: string) { console.log(`\n${C.bold}${C.cyan}── ${msg} ──${C.reset}`); }
function ok(msg: string) { console.log(`  ${C.green}✔${C.reset} ${msg}`); }
function warn(msg: string) { console.log(`  ${C.yellow}⚠${C.reset} ${msg}`); }
function err(msg: string) { console.log(`  ${C.red}✘${C.reset} ${msg}`); }
function info(msg: string) { console.log(`  ${C.dim}${msg}${C.reset}`); }

// ── Neo4j ────────────────────────────────────────────────────
async function getNeo4jChunks(
    sampleSize: number,
    filterUserId?: string
): Promise<Array<{ docId: string; chunkText: string }>> {
    const uri = process.env.NEO4J_URI!;
    const user = process.env.NEO4J_USER || process.env.NEO4J_USERNAME!;
    const password = process.env.NEO4J_PASSWORD!;

    const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
    const session = driver.session();

    try {
        // Grab chunks that have at least one concept extracted from them
        const filter = filterUserId ? `{userId: $userId}` : '';
        const params: Record<string, unknown> = filterUserId ? { userId: filterUserId } : {};

        const result = await session.run(
            `MATCH (c:Concept ${filter})
             WHERE c.sourceChunk IS NOT NULL AND length(c.sourceChunk) > 200
             RETURN c.documentId AS docId, c.sourceChunk AS chunkText
             ORDER BY rand()
             LIMIT $limit`,
            { ...params, limit: neo4j.int(sampleSize) }
        );

        return result.records.map((r) => ({
            docId: r.get('docId') as string,
            chunkText: r.get('chunkText') as string,
        }));
    } finally {
        await session.close();
        await driver.close();
    }
}

// ── LLM extraction ───────────────────────────────────────────
interface ExtractionResult {
    concepts: string[];
    triples: Array<{ from: string; type: string; to: string }>;
}

const SYSTEM_PROMPT = `You are an educational knowledge graph extractor for CBSE Grade 4–10.
Given a text passage, extract:
1. Key concepts (noun phrases, up to 10)
2. Relationships between them as triples (subject, predicate, object)
   Use predicate types: IS_A | CAUSES | REQUIRES | PART_OF | CONTRASTS_WITH | EXAMPLE_OF | USED_FOR | FEATURE_OF | PRECEDES | EXTENSION_OF | RELATES_TO

Respond ONLY with valid JSON:
{
  "concepts": ["concept1", "concept2", ...],
  "triples": [
    {"from": "concept1", "type": "RELATION_TYPE", "to": "concept2"},
    ...
  ]
}`;

async function extractOnce(
    groq: Groq,
    chunkText: string,
    temperature: number
): Promise<ExtractionResult> {
    const completion = await groq.chat.completions.create({
        model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
        temperature,
        max_tokens: 1000,
        response_format: { type: 'json_object' },
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `Passage:\n${chunkText.substring(0, 1500)}` },
        ],
    });

    const raw = completion.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);

    const concepts = (parsed.concepts || []).map((c: string) => c.toLowerCase().trim());
    const triples = (parsed.triples || []).map((t: { from: string; type: string; to: string }) => ({
        from: t.from?.toLowerCase().trim() || '',
        type: (t.type || 'RELATES_TO').toUpperCase().trim(),
        to: t.to?.toLowerCase().trim() || '',
    })).filter((t: { from: string; type: string; to: string }) => t.from && t.to && t.from !== t.to);

    return { concepts, triples };
}

// ── Agreement metrics ────────────────────────────────────────
function jaccardSets<T>(a: Set<T>, b: Set<T>): number {
    if (a.size === 0 && b.size === 0) return 1;
    const union = new Set([...a, ...b]);
    const intersection = [...a].filter((x) => b.has(x));
    return intersection.length / union.size;
}

function tripleKey(t: { from: string; type: string; to: string }): string {
    return `${t.from}::${t.type}::${t.to}`;
}

function computeAgreement(runs: ExtractionResult[]): {
    conceptAgreement: number;   // fraction of concepts present in ≥ majority of runs
    tripleAgreement: number;    // fraction of triples present in ≥ majority of runs
    avgJaccard: number;         // average pairwise Jaccard on concept sets
    stableConceptCount: number;
    stableTripleCount: number;
} {
    const majority = Math.ceil(runs.length / 2);

    // Count occurrences across runs
    const conceptCounts = new Map<string, number>();
    const tripleCounts = new Map<string, number>();

    for (const run of runs) {
        for (const c of run.concepts) {
            conceptCounts.set(c, (conceptCounts.get(c) || 0) + 1);
        }
        for (const t of run.triples) {
            const key = tripleKey(t);
            tripleCounts.set(key, (tripleCounts.get(key) || 0) + 1);
        }
    }

    const stableConceptCount = [...conceptCounts.values()].filter((v) => v >= majority).length;
    const stableTripleCount = [...tripleCounts.values()].filter((v) => v >= majority).length;
    const totalUniqueConceptCount = conceptCounts.size;
    const totalUniqueTripleCount = tripleCounts.size;

    const conceptAgreement = totalUniqueConceptCount > 0
        ? stableConceptCount / totalUniqueConceptCount
        : 0;
    const tripleAgreement = totalUniqueTripleCount > 0
        ? stableTripleCount / totalUniqueTripleCount
        : 0;

    // Pairwise Jaccard on concept sets
    const jaccards: number[] = [];
    for (let i = 0; i < runs.length; i++) {
        for (let j = i + 1; j < runs.length; j++) {
            const a = new Set(runs[i].concepts);
            const b = new Set(runs[j].concepts);
            jaccards.push(jaccardSets(a, b));
        }
    }
    const avgJaccard = jaccards.length > 0
        ? jaccards.reduce((s, v) => s + v, 0) / jaccards.length
        : 0;

    return { conceptAgreement, tripleAgreement, avgJaccard, stableConceptCount, stableTripleCount };
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
    console.log(`\n${C.bold}${C.magenta}Study Lens — LLM Consensus KG Evaluator${C.reset}`);
    console.log(`Chunks: ${chunkSample}  |  Runs per chunk: ${runsPerChunk}  |  User: ${userId || 'all'}\n`);

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });

    // 1. Fetch sample chunks from Neo4j
    header('Step 1 — Fetching chunk samples from Neo4j');
    let chunks: Array<{ docId: string; chunkText: string }> = [];
    try {
        chunks = await getNeo4jChunks(chunkSample, userId);
        ok(`Fetched ${chunks.length} chunk(s)`);
    } catch (e) {
        err(`Neo4j fetch failed: ${(e as Error).message}`);
        console.log(`\n${C.yellow}Note: If Neo4j is unavailable, you can still run this script by`);
        console.log(`providing chunk text directly via --text="..." (future flag).${C.reset}\n`);
        process.exit(1);
    }

    if (chunks.length === 0) {
        warn('No chunks with sourceChunk property found. Re-upload a document to populate sourceChunk on Concept nodes.');
        warn('Alternatively, run with sample text via future --sampleText flag.');
        process.exit(0);
    }

    // 2. Run consensus extraction per chunk
    header('Step 2 — Running consensus extraction');

    const temperatures = [0.1, 0.4, 0.7].slice(0, runsPerChunk);
    const chunkResults: Array<{
        docId: string;
        conceptAgreement: number;
        tripleAgreement: number;
        avgJaccard: number;
        stableConceptCount: number;
        stableTripleCount: number;
    }> = [];

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        info(`[${i + 1}/${chunks.length}] Chunk from doc ${chunk.docId?.substring(0, 8)}…`);

        const runs: ExtractionResult[] = [];
        for (const temp of temperatures) {
            try {
                const result = await extractOnce(groq, chunk.chunkText, temp);
                runs.push(result);
                // Rate-limit: Groq free tier
                await new Promise((r) => setTimeout(r, 500));
            } catch (e) {
                warn(`  Run at temp=${temp} failed: ${(e as Error).message}`);
            }
        }

        if (runs.length < 2) {
            warn('  Not enough successful runs — skipping this chunk');
            continue;
        }

        const agreement = computeAgreement(runs);
        chunkResults.push({ docId: chunk.docId, ...agreement });

        const jacc = (agreement.avgJaccard * 100).toFixed(1);
        const ca = (agreement.conceptAgreement * 100).toFixed(1);
        const ta = (agreement.tripleAgreement * 100).toFixed(1);
        info(`  Concept agreement: ${ca}%  |  Triple agreement: ${ta}%  |  Avg Jaccard: ${jacc}%`);
    }

    if (chunkResults.length === 0) {
        err('No chunks could be evaluated. Exiting.');
        process.exit(1);
    }

    // 3. Aggregate scores
    header('Step 3 — Aggregate Report');

    const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;

    const avgConceptAgreement = avg(chunkResults.map((r) => r.conceptAgreement)) * 100;
    const avgTripleAgreement = avg(chunkResults.map((r) => r.tripleAgreement)) * 100;
    const avgJaccard = avg(chunkResults.map((r) => r.avgJaccard)) * 100;

    // Quality interpretation
    const conceptGrade = avgConceptAgreement >= 75 ? '🟢 GOOD' : avgConceptAgreement >= 55 ? '🟡 MODERATE' : '🔴 LOW';
    const tripleGrade = avgTripleAgreement >= 60 ? '🟢 GOOD' : avgTripleAgreement >= 40 ? '🟡 MODERATE' : '🔴 LOW';
    const jaccardGrade = avgJaccard >= 65 ? '🟢 GOOD' : avgJaccard >= 45 ? '🟡 MODERATE' : '🔴 LOW';

    console.log(`
  ┌────────────────────────────────────────────────────────┐
  │           KG Consensus Quality Report                  │
  ├────────────────────────────────────────────────────────┤
  │  Chunks evaluated : ${String(chunkResults.length).padEnd(4)}                            │
  │  Runs per chunk   : ${String(runsPerChunk).padEnd(4)}                            │
  ├────────────────────────────────────────────────────────┤
  │  Concept Agreement: ${avgConceptAgreement.toFixed(1).padStart(5)}%   ${conceptGrade.padEnd(14)}       │
  │  Triple Agreement : ${avgTripleAgreement.toFixed(1).padStart(5)}%   ${tripleGrade.padEnd(14)}       │
  │  Avg Jaccard Sim  : ${avgJaccard.toFixed(1).padStart(5)}%   ${jaccardGrade.padEnd(14)}       │
  └────────────────────────────────────────────────────────┘`);

    console.log(`\n${C.bold}Interpretation:${C.reset}`);
    if (avgConceptAgreement < 55) {
        warn('Low concept agreement means the LLM extracts different concepts each time.');
        warn('→ Consider tightening the extraction prompt or lowering temperature.');
    } else {
        ok('Concept extraction is stable across runs.');
    }

    if (avgTripleAgreement < 40) {
        warn('Low triple agreement — relationships are highly non-deterministic.');
        warn('→ Consider adding more explicit relationship examples to the system prompt.');
    } else {
        ok('Relationship extraction is reasonably stable.');
    }

    if (avgJaccard < 45) {
        warn('Low pairwise Jaccard — different runs produce very different concept vocabularies.');
        warn('→ Chunks may be too long or the content may be genuinely ambiguous.');
    } else {
        ok('Concept vocabulary is consistent across runs — good extraction reliability.');
    }

    // 4. Write JSON report
    const report = {
        timestamp: new Date().toISOString(),
        userId: userId || 'all',
        chunksSampled: chunkResults.length,
        runsPerChunk,
        scores: {
            avgConceptAgreement: Math.round(avgConceptAgreement * 10) / 10,
            avgTripleAgreement: Math.round(avgTripleAgreement * 10) / 10,
            avgJaccard: Math.round(avgJaccard * 10) / 10,
        },
        perChunk: chunkResults.map((r) => ({
            docId: r.docId,
            conceptAgreement: Math.round(r.conceptAgreement * 1000) / 10,
            tripleAgreement: Math.round(r.tripleAgreement * 1000) / 10,
            avgJaccard: Math.round(r.avgJaccard * 1000) / 10,
            stableConceptCount: r.stableConceptCount,
            stableTripleCount: r.stableTripleCount,
        })),
    };

    const outPath = path.join(__dirname, '..', 'kg-consensus-report.json');
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    ok(`Report written → ${outPath}`);
    console.log();
}

main().catch((e) => {
    console.error('Fatal error:', e);
    process.exit(1);
});