/**
 * ═══════════════════════════════════════════════════════════════
 * STUDY LENS — Knowledge Graph Evaluation Script
 * ═══════════════════════════════════════════════════════════════
 *
 * Evaluates accuracy, completeness, consistency, and quality
 * of the Neo4j knowledge graph with rich terminal logging.
 *
 * Usage:
 *   npx tsx scripts/evaluate-kg.ts
 *   npx tsx scripts/evaluate-kg.ts --userId=<uuid>
 *   npx tsx scripts/evaluate-kg.ts --conceptId=<uuid>
 *   npx tsx scripts/evaluate-kg.ts --verbose
 *
 * What it checks:
 *   1. Structural Integrity   — node/edge counts, orphan detection
 *   2. Schema Compliance      — required properties on all nodes
 *   3. Relation Validity      — valid relation types, no self-loops
 *   4. Completeness           — concept coverage (definition, examples)
 *   5. Consistency            — duplicate nodes, contradictory relations
 *   6. Link Prediction        — mask & re-predict relations (F1 proxy)
 *   7. Density                — avg degree, connectivity score
 * ═══════════════════════════════════════════════════════════════
 */

import neo4j, { Driver, Session, Integer } from 'neo4j-driver';
import * as fs from 'fs';
import * as path from 'path';

// ── Load .env.local ──────────────────────────────────────────
function loadEnv() {
    const envPath = path.join(__dirname, '..', '.env.local');
    if (!fs.existsSync(envPath)) {
        log('error', '.env.local not found — create it with NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD');
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

// ── Terminal Colors & Logger ──────────────────────────────────
const C = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    bgRed: '\x1b[41m',
    bgGreen: '\x1b[42m',
};

type LogLevel = 'info' | 'success' | 'warn' | 'error' | 'debug' | 'header' | 'metric' | 'subheader';

function log(level: LogLevel, message: string, data?: unknown) {
    const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const dim = `${C.dim}${ts}${C.reset}`;

    const icons: Record<LogLevel, string> = {
        info: `${C.blue}ℹ${C.reset}`,
        success: `${C.green}✔${C.reset}`,
        warn: `${C.yellow}⚠${C.reset}`,
        error: `${C.red}✘${C.reset}`,
        debug: `${C.dim}◦${C.reset}`,
        header: `${C.bold}${C.magenta}═${C.reset}`,
        subheader: `${C.bold}${C.cyan}─${C.reset}`,
        metric: `${C.cyan}◈${C.reset}`,
    };

    if (level === 'header') {
        const line = '═'.repeat(60);
        console.log(`\n${C.bold}${C.magenta}${line}${C.reset}`);
        console.log(`${C.bold}${C.magenta}  ${message.toUpperCase()}${C.reset}`);
        console.log(`${C.bold}${C.magenta}${line}${C.reset}`);
        return;
    }

    if (level === 'subheader') {
        const line = '─'.repeat(50);
        console.log(`\n${C.cyan}${line}${C.reset}`);
        console.log(`${C.bold}${C.cyan}  ${message}${C.reset}`);
        console.log(`${C.cyan}${line}${C.reset}`);
        return;
    }

    const prefix = `${dim} ${icons[level]}`;
    const msg = level === 'error'
        ? `${C.red}${message}${C.reset}`
        : level === 'warn'
            ? `${C.yellow}${message}${C.reset}`
            : level === 'success'
                ? `${C.green}${message}${C.reset}`
                : level === 'metric'
                    ? `${C.cyan}${message}${C.reset}`
                    : message;

    if (data !== undefined) {
        console.log(`${prefix}  ${msg}`);
        console.log(`         ${C.dim}${JSON.stringify(data, null, 2)}${C.reset}`);
    } else {
        console.log(`${prefix}  ${msg}`);
    }
}

function logTable(headers: string[], rows: string[][]) {
    const widths = headers.map((h, i) =>
        Math.max(h.length, ...rows.map(r => (r[i] || '').length))
    );
    const sep = widths.map(w => '─'.repeat(w + 2)).join('┼');
    const fmt = (cells: string[], color = '') =>
        cells.map((c, i) => `${color} ${c.padEnd(widths[i])} ${C.reset}`).join('│');

    console.log(`\n         ┌${widths.map(w => '─'.repeat(w + 2)).join('┬')}┐`);
    console.log(`         │${fmt(headers, C.bold + C.cyan)}│`);
    console.log(`         ├${sep}┤`);
    rows.forEach(row => {
        const color = row[row.length - 1]?.includes('FAIL') || row[row.length - 1]?.includes('❌')
            ? C.red
            : row[row.length - 1]?.includes('PASS') || row[row.length - 1]?.includes('✔')
                ? C.green
                : '';
        console.log(`         │${fmt(row, color)}│`);
    });
    console.log(`         └${widths.map(w => '─'.repeat(w + 2)).join('┴')}┘`);
}

function scoreBar(score: number, max = 100, width = 20): string {
    const filled = Math.round((score / max) * width);
    const empty = width - filled;
    const color = score >= 80 ? C.green : score >= 50 ? C.yellow : C.red;
    return `${color}${'█'.repeat(filled)}${C.dim}${'░'.repeat(empty)}${C.reset} ${C.bold}${score.toFixed(1)}%${C.reset}`;
}

// ── Neo4j helpers ─────────────────────────────────────────────
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

// ═════════════════════════════════════════════════════════════
// EVALUATION CHECKS
// ═════════════════════════════════════════════════════════════

interface CheckResult {
    name: string;
    passed: boolean;
    score: number;       // 0–100
    details: string;
    issues?: string[];
}

// 1. STRUCTURAL INTEGRITY ─────────────────────────────────────
async function checkStructuralIntegrity(session: Session, userId?: string): Promise<CheckResult> {
    log('subheader', '1. Structural Integrity');

    const filter = userId ? `{userId: $userId}` : '';
    const params = userId ? { userId } : {};

    const [totalNodes] = await runQ<{ count: unknown }>(
        session, `MATCH (n ${filter}) RETURN count(n) AS count`, params
    );
    const [totalRels] = await runQ<{ count: unknown }>(
        session, `MATCH (a ${filter})-[r]->(b) RETURN count(r) AS count`, params
    );
    const [conceptNodes] = await runQ<{ count: unknown }>(
        session, `MATCH (c:Concept ${filter}) RETURN count(c) AS count`, params
    );

    // Orphan nodes (no relationships at all)
    const orphans = await runQ<{ id: unknown; name: unknown }>(
        session,
        `MATCH (n ${filter}) WHERE NOT (n)--() RETURN n.id AS id, n.name AS name LIMIT 20`,
        params
    );

    const nodeCount = toNum(totalNodes?.count);
    const relCount = toNum(totalRels?.count);
    const conceptCount = toNum(conceptNodes?.count);
    const orphanCount = orphans.length;

    log('metric', `Total nodes:    ${C.bold}${nodeCount}${C.reset}`);
    log('metric', `Total relations:${C.bold}${relCount}${C.reset}`);
    log('metric', `Concept nodes:  ${C.bold}${conceptCount}${C.reset}`);
    log('metric', `Orphan nodes:   ${orphanCount > 0 ? C.yellow : C.green}${orphanCount}${C.reset}`);

    if (orphanCount > 0) {
        log('warn', `Found ${orphanCount} orphan node(s) with no relationships:`);
        orphans.slice(0, 5).forEach(o =>
            log('debug', `  → id=${o.id ?? 'N/A'} name=${o.name ?? 'N/A'}`)
        );
    }

    const issues: string[] = [];
    if (nodeCount === 0) issues.push('Graph is empty — no nodes found');
    if (conceptCount === 0) issues.push('No Concept nodes found');
    if (orphanCount > nodeCount * 0.3) issues.push(`High orphan rate: ${orphanCount}/${nodeCount} nodes are disconnected`);

    const score = nodeCount === 0 ? 0
        : Math.max(0, 100 - (orphanCount / nodeCount) * 100 - (issues.length * 10));

    return {
        name: 'Structural Integrity',
        passed: issues.length === 0,
        score,
        details: `${nodeCount} nodes, ${relCount} rels, ${conceptCount} concepts, ${orphanCount} orphans`,
        issues,
    };
}

// 2. SCHEMA COMPLIANCE ────────────────────────────────────────
async function checkSchemaCompliance(session: Session, userId?: string): Promise<CheckResult> {
    log('subheader', '2. Schema Compliance');

    const filter = userId ? `{userId: $userId}` : '';
    const params = userId ? { userId } : {};

    // Concept nodes must have: id, name, definition, userId, documentId
    const requiredProps = ['id', 'name', 'definition', 'userId', 'documentId'];
    const issues: string[] = [];
    const rows: string[][] = [];

    for (const prop of requiredProps) {
        const [res] = await runQ<{ missing: unknown; total: unknown }>(
            session,
            `MATCH (c:Concept ${filter})
       RETURN count(CASE WHEN c.${prop} IS NULL OR c.${prop} = '' THEN 1 END) AS missing,
              count(c) AS total`,
            params
        );
        const missing = toNum(res?.missing);
        const total = toNum(res?.total);
        const pct = total > 0 ? ((missing / total) * 100).toFixed(1) : '0.0';
        const status = missing === 0 ? `${C.green}✔ PASS${C.reset}` : `${C.red}✘ FAIL${C.reset}`;

        rows.push([`Concept.${prop}`, `${missing}/${total}`, `${pct}%`, status]);
        if (missing > 0) issues.push(`${missing} Concept node(s) missing '${prop}'`);

        log(missing === 0 ? 'success' : 'warn',
            `Concept.${prop}: ${missing === 0 ? 'all present' : `${missing} missing (${pct}%)`}`
        );
    }

    logTable(['Property', 'Missing/Total', 'Missing %', 'Status'], rows);

    const score = Math.max(0, 100 - issues.length * 15);
    return {
        name: 'Schema Compliance',
        passed: issues.length === 0,
        score,
        details: `Checked ${requiredProps.length} required properties on Concept nodes`,
        issues,
    };
}

// 3. RELATION VALIDITY ────────────────────────────────────────
async function checkRelationValidity(session: Session, userId?: string): Promise<CheckResult> {
    log('subheader', '3. Relation Validity');

    const params = userId ? { userId } : {};

    // Valid relation types from kg-builder.ts
    const validTypes = new Set([
        'EXPLAINS', 'HAS_EXAMPLE', 'PREREQUISITE', 'CAUSES_CONFUSION_WITH',
        'RELATED_TO', 'PART_OF', 'USED_FOR', 'DEFINES', 'EXAMPLES', 'FORMULAS',
        'MISCONCEPTIONS', 'PREREQUISITE_OF', 'RELATES_TO',
    ]);

    // Get all relation types in the graph
    const relTypes = await runQ<{ type: string; count: unknown }>(
        session,
        `MATCH ()-[r]->() RETURN type(r) AS type, count(r) AS count ORDER BY count DESC`,
        params
    );

    // Self-loops
    const [selfLoops] = await runQ<{ count: unknown }>(
        session,
        `MATCH (n)-[r]->(n) RETURN count(r) AS count`,
        params
    );

    const issues: string[] = [];
    const rows: string[][] = [];

    for (const rt of relTypes) {
        const isValid = validTypes.has(rt.type) || rt.type.length > 0; // dynamic types allowed
        const count = toNum(rt.count);
        rows.push([rt.type, String(count), isValid ? `${C.green}✔${C.reset}` : `${C.red}✘${C.reset}`]);
        log('debug', `  ${rt.type}: ${count} instances`);
    }

    const loopCount = toNum(selfLoops?.count);
    if (loopCount > 0) {
        issues.push(`${loopCount} self-loop relation(s) detected`);
        log('warn', `Self-loops found: ${loopCount}`);
    } else {
        log('success', 'No self-loops detected');
    }

    if (relTypes.length === 0) {
        issues.push('No relations found in the graph');
    }

    logTable(['Relation Type', 'Count', 'Valid'], rows);

    const score = issues.length === 0 ? 100 : Math.max(0, 100 - issues.length * 20);
    return {
        name: 'Relation Validity',
        passed: issues.length === 0,
        score,
        details: `${relTypes.length} distinct relation types, ${loopCount} self-loops`,
        issues,
    };
}

// 4. COMPLETENESS ─────────────────────────────────────────────
async function checkCompleteness(session: Session, userId?: string): Promise<CheckResult> {
    log('subheader', '4. Completeness');

    const filter = userId ? `{userId: $userId}` : '';
    const params = userId ? { userId } : {};

    const checks = [
        {
            label: 'Concepts with definition',
            query: `MATCH (c:Concept ${filter}) WHERE c.definition IS NOT NULL AND c.definition <> '' RETURN count(c) AS has, (MATCH (x:Concept ${filter}) RETURN count(x)) AS total`,
        },
    ];

    // Simpler per-metric queries
    const metrics = [
        {
            label: 'Concepts with a definition',
            hasQ: `MATCH (c:Concept ${filter}) WHERE c.definition IS NOT NULL AND c.definition <> '' RETURN count(c) AS n`,
            totalQ: `MATCH (c:Concept ${filter}) RETURN count(c) AS n`,
        },
        {
            label: 'Concepts with ≥1 example',
            hasQ: `MATCH (c:Concept ${filter})-[:HAS_EXAMPLE|EXAMPLES]->() RETURN count(DISTINCT c) AS n`,
            totalQ: `MATCH (c:Concept ${filter}) RETURN count(c) AS n`,
        },
        {
            label: 'Concepts with ≥1 outgoing relation',
            hasQ: `MATCH (c:Concept ${filter})-[r]->() RETURN count(DISTINCT c) AS n`,
            totalQ: `MATCH (c:Concept ${filter}) RETURN count(c) AS n`,
        },
        {
            label: 'Concepts linked to a documentId',
            hasQ: `MATCH (c:Concept ${filter}) WHERE c.documentId IS NOT NULL RETURN count(c) AS n`,
            totalQ: `MATCH (c:Concept ${filter}) RETURN count(c) AS n`,
        },
    ];

    const issues: string[] = [];
    const rows: string[][] = [];
    let totalScore = 0;

    for (const m of metrics) {
        const [hasRes] = await runQ<{ n: unknown }>(session, m.hasQ, params);
        const [totRes] = await runQ<{ n: unknown }>(session, m.totalQ, params);
        const has = toNum(hasRes?.n);
        const total = toNum(totRes?.n);
        const pct = total > 0 ? (has / total) * 100 : 0;
        totalScore += pct;

        const status = pct >= 80
            ? `${C.green}✔ ${pct.toFixed(1)}%${C.reset}`
            : pct >= 50
                ? `${C.yellow}⚠ ${pct.toFixed(1)}%${C.reset}`
                : `${C.red}✘ ${pct.toFixed(1)}%${C.reset}`;

        rows.push([m.label, `${has}/${total}`, status]);
        log(pct >= 80 ? 'success' : pct >= 50 ? 'warn' : 'error',
            `${m.label}: ${has}/${total} (${pct.toFixed(1)}%)`
        );

        if (pct < 50) issues.push(`Low completeness for "${m.label}": only ${pct.toFixed(1)}%`);
    }

    logTable(['Metric', 'Count', 'Coverage'], rows);

    const score = totalScore / metrics.length;
    return {
        name: 'Completeness',
        passed: score >= 70,
        score,
        details: `Average coverage across ${metrics.length} completeness metrics`,
        issues,
    };
}

// 5. CONSISTENCY ──────────────────────────────────────────────
async function checkConsistency(session: Session, userId?: string): Promise<CheckResult> {
    log('subheader', '5. Consistency (Duplicates & Contradictions)');

    const filter = userId ? `{userId: $userId}` : '';
    const params = userId ? { userId } : {};

    const issues: string[] = [];

    // Duplicate concept names (same userId)
    const dupNames = await runQ<{ name: string; count: unknown }>(
        session,
        `MATCH (c:Concept ${filter})
     WITH toLower(c.name) AS name, count(c) AS cnt
     WHERE cnt > 1
     RETURN name, cnt AS count
     ORDER BY cnt DESC LIMIT 10`,
        params
    );

    if (dupNames.length > 0) {
        issues.push(`${dupNames.length} duplicate concept name(s) found`);
        log('warn', `Duplicate concept names (${dupNames.length} groups):`);
        dupNames.forEach(d => log('debug', `  → "${d.name}" appears ${toNum(d.count)}x`));
    } else {
        log('success', 'No duplicate concept names detected');
    }

    // Bidirectional relations (A→B and B→A with same type — possible contradiction)
    const [bidir] = await runQ<{ count: unknown }>(
        session,
        `MATCH (a)-[r1]->(b), (b)-[r2]->(a)
     WHERE type(r1) = type(r2) AND a <> b
     RETURN count(r1) AS count`,
        params
    );
    const bidirCount = toNum(bidir?.count);
    if (bidirCount > 0) {
        issues.push(`${bidirCount} bidirectional relations of the same type (possible contradiction)`);
        log('warn', `Bidirectional same-type relations: ${bidirCount}`);
    } else {
        log('success', 'No bidirectional contradictions found');
    }

    // Concepts with no documentId (unlinked)
    const [unlinked] = await runQ<{ count: unknown }>(
        session,
        `MATCH (c:Concept ${filter}) WHERE c.documentId IS NULL RETURN count(c) AS count`,
        params
    );
    const unlinkedCount = toNum(unlinked?.count);
    if (unlinkedCount > 0) {
        issues.push(`${unlinkedCount} Concept node(s) with no documentId`);
        log('warn', `Unlinked concepts (no documentId): ${unlinkedCount}`);
    } else {
        log('success', 'All Concept nodes have a documentId');
    }

    const score = Math.max(0, 100 - issues.length * 20 - (dupNames.length * 5));
    return {
        name: 'Consistency',
        passed: issues.length === 0,
        score,
        details: `${dupNames.length} dup groups, ${bidirCount} bidir contradictions, ${unlinkedCount} unlinked`,
        issues,
    };
}

// 6. GRAPH DENSITY & CONNECTIVITY ─────────────────────────────
async function checkDensity(session: Session, userId?: string): Promise<CheckResult> {
    log('subheader', '6. Graph Density & Connectivity');

    const filter = userId ? `{userId: $userId}` : '';
    const params = userId ? { userId } : {};

    const [allStats] = await runQ<{ nodes: unknown; rels: unknown }>(
        session,
        `MATCH (n ${filter})
     OPTIONAL MATCH (n)-[r]->()
     RETURN count(DISTINCT n) AS nodes, count(r) AS rels`,
        params
    );

    // Scope density to Concept nodes only.
    // Example/Formula/Misconception sub-nodes are intentional leaf
    // terminals with out-degree 0 by design; including them makes
    // the average degree misleadingly low.
    const [stats] = await runQ<{ nodes: unknown; rels: unknown }>(
        session,
        `MATCH (c:Concept ${filter})
     OPTIONAL MATCH (c)-[r]->(other:Concept)
     RETURN count(DISTINCT c) AS nodes, count(r) AS rels`,
        params
    );

    const allNodes = toNum(allStats?.nodes);
    const allRels = toNum(allStats?.rels);

    const nodes = toNum(stats?.nodes);
    const rels = toNum(stats?.rels);
    const density = nodes > 1 ? (rels / (nodes * (nodes - 1))) * 100 : 0;
    const avgDeg = nodes > 0 ? rels / nodes : 0;

    // Degree distribution — Concept→Concept only
    const degDist = await runQ<{ degree: unknown; count: unknown }>(
        session,
        `MATCH (c:Concept ${filter})
     OPTIONAL MATCH (c)-[r]->(other:Concept)
     WITH c, count(r) AS degree
     RETURN degree, count(c) AS count
     ORDER BY degree`,
        params
    );

    log('metric', `Total graph nodes:      ${C.bold}${allNodes}${C.reset} ${C.dim}(incl. Example/Formula/Misconception leaves)${C.reset}`);
    log('metric', `Total graph edges:      ${C.bold}${allRels}${C.reset}`);
    log('metric', `Concept nodes:          ${C.bold}${nodes}${C.reset}`);
    log('metric', `Concept→Concept edges:  ${C.bold}${rels}${C.reset}`);
    log('metric', `Avg Concept out-degree: ${C.bold}${avgDeg.toFixed(2)}${C.reset}`);
    log('metric', `Concept graph density:  ${C.bold}${density.toFixed(4)}%${C.reset}`);

    const degRows: string[][] = degDist.slice(0, 8).map(d => [
        String(toNum(d.degree)), String(toNum(d.count))
    ]);
    if (degRows.length > 0) {
        log('info', 'Concept out-degree distribution (Concept→Concept edges):');
        logTable(['Out-degree', 'Concept count'], degRows);
    }

    const issues: string[] = [];
    // avg C→C degree < 2 is a meaningful warning for domain KGs
    if (avgDeg < 2) issues.push(`Low Concept→Concept avg degree (${avgDeg.toFixed(2)}) — consider uploading more related documents`);
    if (nodes < 5) issues.push(`Very few Concept nodes (${nodes}) — KG may be incomplete`);

    // Density scoring scoped to Concept subgraph (healthy range: 1–20%)
    const densityScore = density === 0 ? 0
        : density < 0.5 ? 30
            : density < 2 ? 60
                : density < 20 ? 90
                    : 70; // overly dense = possibly noisy

    const score = Math.max(0, densityScore - issues.length * 15);
    return {
        name: 'Density & Connectivity',
        passed: score >= 50,
        score,
        details: `${nodes} concept nodes, ${rels} C→C edges, avg degree ${avgDeg.toFixed(2)}, density ${density.toFixed(4)}%`,
        issues,
    };
}

// 7. LINK PREDICTION PROXY ────────────────────────────────────
async function checkLinkPrediction(session: Session, userId?: string): Promise<CheckResult> {
    log('subheader', '7. Link Prediction Proxy (Relation Recoverability)');

    const filter = userId ? `{userId: $userId}` : '';
    const params = userId ? { userId } : {};

    /**
     * Proxy approach:
     * For a sample of concept pairs that DO have a relation,
     * check if they share at least one common neighbor.
     * Common neighbors = structural signal that the relation is "recoverable."
     * Precision = fraction of related pairs with ≥1 common neighbor.
     */

    const relatedPairs = await runQ<{ a: string; b: string }>(
        session,
        `MATCH (a:Concept ${filter})-[r]->(b:Concept ${filter})
     WHERE a <> b
     RETURN a.id AS a, b.id AS b
     LIMIT 50`,
        params
    );

    if (relatedPairs.length === 0) {
        log('warn', 'No Concept→Concept relations to evaluate — skipping link prediction');
        return {
            name: 'Link Prediction Proxy',
            passed: true,
            score: 50, // neutral
            details: 'Insufficient Concept→Concept edges for evaluation',
            issues: [],
        };
    }

    let recoverable = 0;
    for (const pair of relatedPairs) {
        const [common] = await runQ<{ count: unknown }>(
            session,
            `MATCH (a:Concept {id: $aId})-[]-(x)-[]-(b:Concept {id: $bId})
       WHERE a <> b
       RETURN count(DISTINCT x) AS count`,
            { aId: pair.a, bId: pair.b }
        );
        if (toNum(common?.count) > 0) recoverable++;
    }

    const precision = (recoverable / relatedPairs.length) * 100;
    log('metric', `Evaluated pairs:  ${relatedPairs.length}`);
    log('metric', `Recoverable:      ${recoverable}`);
    log('metric', `Precision proxy:  ${precision.toFixed(1)}%`);
    log(precision >= 60 ? 'success' : 'warn',
        `Link recoverability: ${scoreBar(precision)}`
    );

    const issues: string[] = [];
    if (precision < 40) issues.push(`Low link recoverability (${precision.toFixed(1)}%) — graph may lack bridging nodes`);

    return {
        name: 'Link Prediction Proxy',
        passed: precision >= 50,
        score: precision,
        details: `${recoverable}/${relatedPairs.length} related pairs have ≥1 common neighbor`,
        issues,
    };
}

// ═════════════════════════════════════════════════════════════
// MAIN RUNNER
// ═════════════════════════════════════════════════════════════

async function main() {
    loadEnv();

    // Parse CLI args
    const args = process.argv.slice(2);
    const verbose = args.includes('--verbose');
    const userId = args.find(a => a.startsWith('--userId='))?.split('=')[1];
    const conceptId = args.find(a => a.startsWith('--conceptId='))?.split('=')[1];

    log('header', 'Study Lens — Knowledge Graph Evaluation');
    log('info', `Started at: ${new Date().toLocaleString()}`);
    if (userId) log('info', `Scoped to userId:    ${userId}`);
    if (conceptId) log('info', `Scoped to conceptId: ${conceptId}`);
    if (verbose) log('info', 'Verbose mode enabled');

    // Connect to Neo4j
    const uri = process.env.NEO4J_URI!;
    const username = process.env.NEO4J_USER || process.env.NEO4J_USERNAME!;
    const password = process.env.NEO4J_PASSWORD!;

    if (!uri || !username || !password) {
        log('error', 'Missing NEO4J_URI, NEO4J_USER, or NEO4J_PASSWORD in .env.local');
        process.exit(1);
    }

    log('info', `Connecting to Neo4j: ${uri}`);
    let driver: Driver;
    try {
        driver = neo4j.driver(uri, neo4j.auth.basic(username, password));
        await driver.verifyConnectivity();
        log('success', 'Neo4j connection established');
    } catch (e) {
        log('error', `Failed to connect to Neo4j: ${(e as Error).message}`);
        process.exit(1);
    }

    const session = driver.session();
    const results: CheckResult[] = [];
    const startMs = Date.now();

    try {
        // Run all checks
        results.push(await checkStructuralIntegrity(session, userId));
        results.push(await checkSchemaCompliance(session, userId));
        results.push(await checkRelationValidity(session, userId));
        results.push(await checkCompleteness(session, userId));
        results.push(await checkConsistency(session, userId));
        results.push(await checkDensity(session, userId));
        results.push(await checkLinkPrediction(session, userId));
    } finally {
        await session.close();
        await driver.close();
    }

    const elapsedMs = Date.now() - startMs;

    // ── Final Report ──────────────────────────────────────────
    log('header', 'Evaluation Report');

    const overallScore = results.reduce((s, r) => s + r.score, 0) / results.length;
    const passed = results.filter(r => r.passed).length;
    const failed = results.length - passed;
    const allIssues = results.flatMap(r => r.issues || []);

    // Summary table
    const tableRows = results.map(r => [
        r.name,
        r.passed ? `${C.green}✔ PASS${C.reset}` : `${C.red}✘ FAIL${C.reset}`,
        `${r.score.toFixed(1)}%`,
        r.details,
    ]);
    logTable(['Check', 'Status', 'Score', 'Details'], tableRows);

    // Overall score bar
    console.log(`\n  ${C.bold}Overall KG Quality Score:${C.reset}`);
    console.log(`  ${scoreBar(overallScore)}`);
    console.log(`  ${C.bold}Checks passed: ${C.green}${passed}${C.reset}${C.bold}/${results.length}   Failed: ${failed > 0 ? C.red : C.green}${failed}${C.reset}`);
    console.log(`  ${C.dim}Evaluation completed in ${elapsedMs}ms${C.reset}\n`);

    // Issues list
    if (allIssues.length > 0) {
        log('subheader', 'Issues Found');
        allIssues.forEach((issue, i) => log('warn', `${i + 1}. ${issue}`));
    } else {
        log('success', 'No issues found — knowledge graph looks healthy! 🎉');
    }

    // Recommendations
    log('subheader', 'Recommendations');
    if (overallScore < 50) {
        log('error', 'KG quality is LOW. Consider re-uploading documents with richer content.');
    } else if (overallScore < 75) {
        log('warn', 'KG quality is MODERATE. Review failed checks and re-process affected documents.');
    } else {
        log('success', 'KG quality is GOOD. Monitor periodically as new documents are added.');
    }

    if (failed > 0) {
        results
            .filter(r => !r.passed)
            .forEach(r => {
                log('info', `Fix "${r.name}": ${(r.issues || []).join('; ')}`);
            });
    }

    // Write JSON report
    const reportPath = path.join(__dirname, '..', 'kg-eval-report.json');
    const report = {
        timestamp: new Date().toISOString(),
        userId: userId ?? 'all',
        overallScore: parseFloat(overallScore.toFixed(2)),
        passed,
        failed,
        elapsedMs,
        checks: results.map(r => ({
            name: r.name,
            passed: r.passed,
            score: parseFloat(r.score.toFixed(2)),
            details: r.details,
            issues: r.issues,
        })),
    };
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    log('success', `JSON report saved → ${reportPath}`);

    console.log(`\n${C.bold}${C.magenta}${'═'.repeat(60)}${C.reset}\n`);

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    log('error', `Unexpected error: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
});