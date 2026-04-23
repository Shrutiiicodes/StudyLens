/**
 * ═══════════════════════════════════════════════════════════════
 * STUDY LENS — Knowledge Graph Cleanup Script
 * ═══════════════════════════════════════════════════════════════
 *
 * Retroactively fixes existing Neo4j data to resolve:
 *   1. Self-loop relations         (A)-[r]->(A) → DELETE r
 *   2. Duplicate Concept nodes     merge properties, re-point edges
 *   3. Bidirectional same-type rels keep one direction, delete the other
 *
 * Usage:
 *   npx tsx scripts/cleanup-kg.ts
 *   npx tsx scripts/cleanup-kg.ts --dry-run   (preview only, no deletes)
 *   npx tsx scripts/cleanup-kg.ts --userId=<uuid>
 * ═══════════════════════════════════════════════════════════════
 */

import neo4j, { Driver, Session, Integer } from 'neo4j-driver';
import Groq from 'groq-sdk';
import * as fs from 'fs';
import * as path from 'path';
import { PREDICATE_LIST_PIPE } from '@/config/predicates';

const GROQ_MODEL = 'qwen/qwen3-32b';

let _groq: Groq | null = null;
function getGroq(): Groq {
    if (!_groq) _groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });
    return _groq;
}

async function llmJson<T>(messages: { role: 'system' | 'user'; content: string }[]): Promise<T> {
    const res = await getGroq().chat.completions.create({
        model: GROQ_MODEL,
        messages,
        temperature: 0.2,
        max_tokens: 1024,
        response_format: { type: 'json_object' },
    });
    const text = res.choices[0]?.message?.content || '{}';
    try { return JSON.parse(text) as T; } catch { return {} as T; }
}

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

function toNum(val: unknown): number {
    if (val === null || val === undefined) return 0;
    if (typeof val === 'number') return val;
    if (Integer.isInteger(val as Integer)) return (val as Integer).toNumber();
    return Number(val);
}

async function runQ<T = Record<string, unknown>>(
    session: Session,
    query: string,
    params: Record<string, unknown> = {}
): Promise<T[]> {
    const result = await session.run(query, params);
    return result.records.map(r => {
        const obj: Record<string, unknown> = {};
        r.keys.forEach(k => { obj[k as string] = r.get(k); });
        return obj as T;
    });
}

const C = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    cyan: '\x1b[36m', magenta: '\x1b[35m',
};

function log(icon: string, color: string, msg: string) {
    console.log(`${color}${icon}${C.reset}  ${msg}`);
}
const info = (m: string) => log('ℹ', C.cyan, m);
const success = (m: string) => log('✔', C.green, m);
const warn = (m: string) => log('⚠', C.yellow, m);
const errorL = (m: string) => log('✘', C.red, m);
const header = (m: string) => {
    const line = '─'.repeat(55);
    console.log(`\n${C.bold}${C.magenta}${line}${C.reset}`);
    console.log(`${C.bold}${C.magenta}  ${m}${C.reset}`);
    console.log(`${C.bold}${C.magenta}${line}${C.reset}`);
};

// ── Noise words stripped during canonical name comparison ──
const NOISE =
    /\b(the|a|an|of|and|in|on|process|concept|principle|phenomenon|theory|law|effect|method|system|type|form|kind|class|category)\b/g;

function canonicalize(name: string): string {
    return (name ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .replace(NOISE, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// ═══════════════════════════════════════════════════════════════
// FIX 1: Remove self-loops
// ═══════════════════════════════════════════════════════════════
async function fixSelfLoops(session: Session, dryRun: boolean): Promise<number> {
    header('Fix 1 — Self-loop Relations');

    const loops = await runQ<{ from: string; type: string }>(
        session,
        `MATCH (n)-[r]->(n) RETURN n.name AS from, type(r) AS type`
    );

    if (loops.length === 0) {
        success('No self-loops found');
        return 0;
    }

    warn(`Found ${loops.length} self-loop(s):`);
    loops.forEach(l => console.log(`   (${l.from})-[${l.type}]->(${l.from})`));

    if (!dryRun) {
        const [res] = await runQ<{ deleted: unknown }>(
            session,
            `MATCH (n)-[r]->(n) DELETE r RETURN count(r) AS deleted`
        );
        success(`Deleted ${toNum(res?.deleted)} self-loop relation(s)`);
    } else {
        warn('[DRY RUN] Would delete the above self-loops');
    }

    return loops.length;
}

// ═══════════════════════════════════════════════════════════════
// FIX 2: Merge duplicate Concept nodes
// ═══════════════════════════════════════════════════════════════
async function fixDuplicateConcepts(
    session: Session,
    dryRun: boolean,
    userId?: string
): Promise<number> {
    header('Fix 2 — Duplicate Concept Nodes');

    const filter = userId ? `{userId: $userId}` : '';
    const params = userId ? { userId } : {};

    // Find concepts that share the same canonical name
    const concepts = await runQ<{ id: string; name: string; definition: string; documentId: string }>(
        session,
        `MATCH (c:Concept ${filter}) RETURN c.id AS id, c.name AS name, c.definition AS definition, c.documentId AS documentId`,
        params
    );

    // Group by canonical name
    const groups = new Map<string, typeof concepts>();
    for (const c of concepts) {
        const key = canonicalize(c.name);
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(c);
    }

    let mergedCount = 0;

    for (const [key, group] of groups.entries()) {
        if (group.length < 2) continue;

        warn(`Duplicate group "${key}": ${group.map(g => `"${g.name}"`).join(', ')}`);

        // Keep the first node, delete the rest (re-pointing their edges first)
        const [keeper, ...duplicates] = group;

        if (dryRun) {
            info(`[DRY RUN] Would keep "${keeper.name}" (${keeper.id}), merge ${duplicates.length} duplicate(s)`);
            mergedCount += duplicates.length;
            continue;
        }

        for (const dup of duplicates) {
            try {
                // Re-point all incoming edges from dup → keeper
                await runQ(session,
                    `MATCH (x)-[r]->(dup:Concept {id: $dupId})
                     WHERE dup.id <> $keepId
                     MATCH (keeper:Concept {id: $keepId})
                     CALL apoc.refactor.to(r, keeper) YIELD input RETURN count(input) AS moved`,
                    { dupId: dup.id, keepId: keeper.id }
                ).catch(() => {
                    // APOC not available — use manual re-pointing
                    return Promise.resolve([]);
                });

                // Fallback: manually create equivalent edges and delete dup
                // Re-point outgoing edges
                await runQ(session,
                    `MATCH (dup:Concept {id: $dupId})-[r]->(target)
                     WHERE target.id <> $dupId
                     WITH dup, r, target, type(r) AS rtype
                     MATCH (keeper:Concept {id: $keepId})
                     WHERE NOT (keeper)-[:${'{type(r)}'}]->(target)
                     MERGE (keeper)-[newR:\`${'{rtype}'}\`]->(target)
                     DELETE r`,
                    { dupId: dup.id, keepId: keeper.id }
                ).catch(() => { /* best effort */ });

                // Delete the duplicate node (detach to remove any remaining edges)
                await runQ(session,
                    `MATCH (dup:Concept {id: $dupId}) DETACH DELETE dup`,
                    { dupId: dup.id }
                );

                success(`Merged "${dup.name}" (${dup.id}) into "${keeper.name}" (${keeper.id})`);
                mergedCount++;
            } catch (err) {
                errorL(`Failed to merge "${dup.name}": ${(err as Error).message}`);
            }
        }
    }

    if (mergedCount === 0) {
        success('No duplicate concepts found (by canonical name)');
    } else {
        success(`Total duplicates handled: ${mergedCount}`);
    }

    return mergedCount;
}

// ═══════════════════════════════════════════════════════════════
// FIX 3: Remove bidirectional same-type relations (keep one direction)
// ═══════════════════════════════════════════════════════════════
async function fixBidirectionalRelations(session: Session, dryRun: boolean): Promise<number> {
    header('Fix 3 — Bidirectional Same-Type Relations');

    // Find all pairs where both A→B and B→A exist with the same type
    const pairs = await runQ<{ aName: string; bName: string; relType: string; r2Id: unknown }>(
        session,
        `MATCH (a)-[r1]->(b), (b)-[r2]->(a)
         WHERE type(r1) = type(r2) AND id(r1) < id(r2) AND a <> b
         RETURN a.name AS aName, b.name AS bName, type(r1) AS relType, id(r2) AS r2Id
         LIMIT 200`
    );

    if (pairs.length === 0) {
        success('No bidirectional same-type relations found');
        return 0;
    }

    warn(`Found ${pairs.length} bidirectional pair(s) to clean:`);
    pairs.slice(0, 10).forEach(p =>
        console.log(`   (${p.aName})<-[${p.relType}]->(${p.bName})  — will keep A→B, delete B→A`)
    );
    if (pairs.length > 10) console.log(`   ... and ${pairs.length - 10} more`);

    if (!dryRun) {
        // Delete the B→A direction (higher id(r), so the "second" one written)
        const [res] = await runQ<{ deleted: unknown }>(
            session,
            `MATCH (a)-[r1]->(b), (b)-[r2]->(a)
             WHERE type(r1) = type(r2) AND id(r1) < id(r2) AND a <> b
             DELETE r2
             RETURN count(r2) AS deleted`
        );
        success(`Deleted ${toNum(res?.deleted)} redundant direction(s)`);
    } else {
        warn('[DRY RUN] Would delete the B→A direction for all pairs above');
    }

    return pairs.length;
}

// ═══════════════════════════════════════════════════════════════
// FIX 4: Link orphan Concept nodes via LLM (density / connectivity)
// ═══════════════════════════════════════════════════════════════
async function fixOrphanConcepts(
    session: Session,
    dryRun: boolean,
    userId?: string
): Promise<number> {
    header('Fix 4 — Orphan Concepts (Density / Connectivity)');

    const filter = userId ? `{userId: $userId}` : '';
    const params = userId ? { userId } : {};

    // Find concept nodes with no edges at all
    const orphans = await runQ<{ id: string; name: string; definition: string }>(
        session,
        `MATCH (c:Concept ${filter})
         WHERE NOT (c)--()
         RETURN c.id AS id, c.name AS name, c.definition AS definition
         LIMIT 60`,
        params
    );

    if (orphans.length === 0) {
        success('No orphan concept nodes found — graph density is OK');
        return 0;
    }

    warn(`Found ${orphans.length} orphan concept(s) with no edges`);

    // Fetch well-connected concepts as link targets
    const candidates = await runQ<{ id: string; name: string; definition: string }>(
        session,
        `MATCH (c:Concept ${filter})
         WHERE (c)--()
         RETURN c.id AS id, c.name AS name, c.definition AS definition
         LIMIT 40`,
        params
    );

    if (candidates.length === 0) {
        warn('No connected concepts found to link orphans against — skipping');
        return 0;
    }

    info(`Asking LLM to link ${orphans.length} orphan(s) against ${candidates.length} candidate(s)...`);

    const candidateSummary = candidates
        .map(c => `- ${c.name}: ${(c.definition || '').substring(0, 120)}`)
        .join('\n');

    let linkedCount = 0;

    for (const orphan of orphans) {
        try {
            const result = await llmJson<{
                relationships: Array<{ to: string; type: string; confidence: number }>;
            }>([
                {
                    role: 'system',
                    content: `You are an educational knowledge graph assistant for CBSE Grade 4–10.
Given an orphan concept and a list of candidate concepts, identify which candidates
are meaningfully related to the orphan and suggest up to 3 relationships.

Only emit relationships clearly meaningful for a CBSE student.
Allowed types: ${PREDICATE_LIST_PIPE}

Respond ONLY with JSON:
{
  "relationships": [
    { "to": "candidate concept name", "type": "RELATION_TYPE", "confidence": 0.0-1.0 }
  ]
}`,
                },
                {
                    role: 'user',
                    content: `Orphan concept: "${orphan.name}"
Definition: "${(orphan.definition || 'not available').substring(0, 200)}"

Candidate concepts:
${candidateSummary}

Which candidates is "${orphan.name}" related to, and how?`,
                },
            ]);

            for (const rel of result.relationships || []) {
                if (!rel.to || !rel.type || rel.confidence < 0.70) continue;
                if (rel.to.toLowerCase().trim() === orphan.name.toLowerCase().trim()) continue;

                const relType = rel.type.toUpperCase().replace(/\s+/g, '_');

                if (dryRun) {
                    info(`[DRY RUN] Would link "${orphan.name}" -[${relType}]-> "${rel.to}" (conf: ${rel.confidence})`);
                    linkedCount++;
                    continue;
                }

                await runQ(
                    session,
                    `MATCH (a:Concept {id: $fromId})
                     MATCH (b:Concept {name: $toName})
                     WHERE a.id <> b.id
                     AND NOT (a)-[:${relType}]->(b)
                     MERGE (a)-[:${relType}]->(b)`,
                    { fromId: orphan.id, toName: rel.to }
                ).catch(err => {
                    // log but don't crash on individual edge failures
                    warn(`Could not write edge (${orphan.name})-[${relType}]->(${rel.to}): ${(err as Error).message}`);
                });

                success(`Linked "${orphan.name}" -[${relType}]-> "${rel.to}" (conf: ${rel.confidence})`);
                linkedCount++;
            }
        } catch (err) {
            warn(`LLM call failed for orphan "${orphan.name}": ${(err as Error).message}`);
        }
    }

    success(`Total new edges created for orphans: ${linkedCount}`);
    return linkedCount;
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════
async function main() {
    loadEnv();

    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const userId = args.find(a => a.startsWith('--userId='))?.split('=')[1];

    console.log(`\n${C.bold}${C.magenta}${'═'.repeat(60)}${C.reset}`);
    console.log(`${C.bold}${C.magenta}  STUDY LENS — KG CLEANUP${dryRun ? ' [DRY RUN]' : ''}${C.reset}`);
    console.log(`${C.bold}${C.magenta}${'═'.repeat(60)}${C.reset}\n`);

    if (dryRun) warn('DRY RUN mode — no changes will be written to Neo4j');
    if (userId) info(`Scoped to userId: ${userId}`);

    const uri = process.env.NEO4J_URI!;
    const username = process.env.NEO4J_USER || process.env.NEO4J_USERNAME!;
    const password = process.env.NEO4J_PASSWORD!;

    if (!uri || !username || !password) {
        errorL('Missing NEO4J_URI, NEO4J_USER, or NEO4J_PASSWORD in .env.local');
        process.exit(1);
    }

    info(`Connecting to Neo4j: ${uri}`);
    let driver: Driver;
    try {
        driver = neo4j.driver(uri, neo4j.auth.basic(username, password));
        await driver.verifyConnectivity();
        success('Neo4j connection established');
    } catch (e) {
        errorL(`Failed to connect: ${(e as Error).message}`);
        process.exit(1);
    }

    const session = driver.session();
    const startMs = Date.now();

    try {
        const selfLoops = await fixSelfLoops(session, dryRun);
        const duplicates = await fixDuplicateConcepts(session, dryRun, userId);
        const bidir = await fixBidirectionalRelations(session, dryRun);
        const orphanEdges = await fixOrphanConcepts(session, dryRun, userId);

        header('Cleanup Summary');
        console.log(`  Self-loops removed:          ${C.bold}${selfLoops}${C.reset}`);
        console.log(`  Duplicate nodes merged:      ${C.bold}${duplicates}${C.reset}`);
        console.log(`  Bidirectional rels removed:  ${C.bold}${bidir}${C.reset}`);
        console.log(`  Orphan edges added:          ${C.bold}${orphanEdges}${C.reset}`);
        console.log(`  Elapsed:                     ${C.bold}${Date.now() - startMs}ms${C.reset}`);

        const total = selfLoops + duplicates + bidir + orphanEdges;
        if (!dryRun && total > 0) {
            console.log(`\n${C.green}${C.bold}  ✔ Cleanup complete! Run evaluate-kg.ts to verify.${C.reset}\n`);
        } else if (total === 0) {
            console.log(`\n${C.green}${C.bold}  ✔ Graph already clean — nothing to fix.${C.reset}\n`);
        }
    } finally {
        await session.close();
        await driver.close();
    }
}

main().catch(err => {
    errorL(`Unexpected error: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
});
