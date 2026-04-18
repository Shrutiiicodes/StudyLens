#!/usr/bin/env tsx
/**
 * ═══════════════════════════════════════════════════════════════
 * STUDY LENS — Human Spot-Evaluation Script
 * ═══════════════════════════════════════════════════════════════
 *
 * Samples N triples from the Neo4j KG and walks a human evaluator
 * (e.g. a teacher) through each one interactively in the terminal.
 *
 * Each triple is marked:
 *   y  → correct (relationship is educationally valid)
 *   n  → incorrect (wrong relationship type or fabricated)
 *   p  → partially correct (right idea, imprecise type)
 *   s  → skip (evaluator unsure)
 *
 * Produces a precision report:
 *   Precision  = correct / (correct + incorrect)
 *   Soft prec  = (correct + 0.5 * partial) / (correct + partial + incorrect)
 *
 * Usage:
 *   npx tsx scripts/spot-evaluate-kg.ts
 *   npx tsx scripts/spot-evaluate-kg.ts --userId=<uuid> --samples=30
 *
 * Output:
 *   kg-spot-eval-report.json  — saved in project root
 * ═══════════════════════════════════════════════════════════════
 */

import neo4j from 'neo4j-driver';
import * as readline from 'readline';
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
const sampleCount = parseInt(
    args.find((a) => a.startsWith('--samples='))?.split('=')[1] || '25',
    10
);

// ── Terminal colors ───────────────────────────────────────────
const C = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    cyan: '\x1b[36m', magenta: '\x1b[35m', blue: '\x1b[34m',
};

// ── Triple type ───────────────────────────────────────────────
interface Triple {
    from: string;
    relType: string;
    to: string;
    fromDef?: string;
    toDef?: string;
}

type Verdict = 'correct' | 'incorrect' | 'partial' | 'skip';

interface EvalRecord {
    triple: Triple;
    verdict: Verdict;
    note?: string;
}

// ── Neo4j helpers ─────────────────────────────────────────────
async function sampleTriples(
    n: number,
    filterUserId?: string
): Promise<Triple[]> {
    const uri = process.env.NEO4J_URI!;
    const user = process.env.NEO4J_USER || process.env.NEO4J_USERNAME!;
    const password = process.env.NEO4J_PASSWORD!;

    const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
    const session = driver.session();

    try {
        const filter = filterUserId ? `{userId: $userId}` : '';
        const params: Record<string, unknown> = filterUserId ? { userId: filterUserId } : {};

        // Sample concept→concept edges only (the educationally meaningful ones)
        const result = await session.run(
            `MATCH (a:Concept ${filter})-[r]->(b:Concept ${filter})
             WHERE type(r) <> 'PART_OF'
             RETURN a.name AS fromName, type(r) AS relType, b.name AS toName,
                    a.definition AS fromDef, b.definition AS toDef
             ORDER BY rand()
             LIMIT $limit`,
            { ...params, limit: neo4j.int(n) }
        );

        return result.records.map((rec) => ({
            from: rec.get('fromName') as string,
            relType: rec.get('relType') as string,
            to: rec.get('toName') as string,
            fromDef: rec.get('fromDef') as string | undefined,
            toDef: rec.get('toDef') as string | undefined,
        }));
    } finally {
        await session.close();
        await driver.close();
    }
}

// ── Interactive prompt ────────────────────────────────────────
function ask(rl: readline.Interface, question: string): Promise<string> {
    return new Promise((resolve) => rl.question(question, resolve));
}

async function runEvaluation(triples: Triple[]): Promise<EvalRecord[]> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const records: EvalRecord[] = [];

    console.log(`\n${C.bold}${C.cyan}╔════════════════════════════════════════════════╗${C.reset}`);
    console.log(`${C.bold}${C.cyan}║   Knowledge Graph Human Spot-Evaluation        ║${C.reset}`);
    console.log(`${C.bold}${C.cyan}╚════════════════════════════════════════════════╝${C.reset}`);
    console.log(`\nYou will be shown ${triples.length} triples extracted from your CBSE documents.`);
    console.log(`For each triple, rate it:\n`);
    console.log(`  ${C.green}y${C.reset} — Correct       (relationship is educationally valid)`);
    console.log(`  ${C.red}n${C.reset} — Incorrect     (wrong type, hallucinated, or misleading)`);
    console.log(`  ${C.yellow}p${C.reset} — Partial       (right idea, imprecise relationship type)`);
    console.log(`  ${C.dim}s${C.reset} — Skip          (unsure, not your subject area)`);
    console.log(`  ${C.dim}q${C.reset} — Quit early    (saves partial results)\n`);
    console.log(`${C.dim}Press Enter after each choice. Notes are optional (press Enter to skip).${C.reset}\n`);

    for (let i = 0; i < triples.length; i++) {
        const triple = triples[i];

        console.log(`\n${C.bold}─── Triple ${i + 1} of ${triples.length} ───────────────────────────────${C.reset}`);
        console.log(
            `  ${C.magenta}${triple.from}${C.reset}  ${C.dim}-[${C.reset}${C.cyan}${triple.relType}${C.reset}${C.dim}]→${C.reset}  ${C.magenta}${triple.to}${C.reset}`
        );

        if (triple.fromDef) {
            console.log(`  ${C.dim}  "${triple.from}": ${triple.fromDef.substring(0, 120)}${C.reset}`);
        }
        if (triple.toDef) {
            console.log(`  ${C.dim}  "${triple.to}": ${triple.toDef.substring(0, 120)}${C.reset}`);
        }

        let verdict: Verdict | null = null;
        while (!verdict) {
            const raw = (await ask(rl, `\n  ${C.bold}[y/n/p/s/q]:${C.reset} `)).trim().toLowerCase();
            if (raw === 'y') verdict = 'correct';
            else if (raw === 'n') verdict = 'incorrect';
            else if (raw === 'p') verdict = 'partial';
            else if (raw === 's') verdict = 'skip';
            else if (raw === 'q') {
                rl.close();
                return records; // save partial
            } else {
                console.log(`  ${C.yellow}Please enter y, n, p, s, or q.${C.reset}`);
            }
        }

        const note = (await ask(rl, `  ${C.dim}Optional note (Enter to skip):${C.reset} `)).trim();

        records.push({ triple, verdict, note: note || undefined });

        const color = verdict === 'correct' ? C.green : verdict === 'incorrect' ? C.red : verdict === 'partial' ? C.yellow : C.dim;
        console.log(`  ${color}→ Marked: ${verdict}${C.reset}`);
    }

    rl.close();
    return records;
}

// ── Report ────────────────────────────────────────────────────
function printReport(records: EvalRecord[]) {
    const evaluated = records.filter((r) => r.verdict !== 'skip');
    const correct = records.filter((r) => r.verdict === 'correct').length;
    const incorrect = records.filter((r) => r.verdict === 'incorrect').length;
    const partial = records.filter((r) => r.verdict === 'partial').length;
    const skipped = records.filter((r) => r.verdict === 'skip').length;
    const total = evaluated.length;

    const precision = total > 0 ? correct / (correct + incorrect + partial) : 0;
    const softPrecision = total > 0
        ? (correct + 0.5 * partial) / (correct + partial + incorrect)
        : 0;

    const grade =
        softPrecision >= 0.85 ? '🟢 HIGH'
            : softPrecision >= 0.65 ? '🟡 MODERATE'
                : '🔴 LOW';

    console.log(`\n${C.bold}${C.cyan}╔════════════════════════════════════════════════╗${C.reset}`);
    console.log(`${C.bold}${C.cyan}║           Spot-Evaluation Report               ║${C.reset}`);
    console.log(`${C.bold}${C.cyan}╚════════════════════════════════════════════════╝${C.reset}`);
    console.log(`
  Triples evaluated : ${total}
  Skipped           : ${skipped}
  ──────────────────────────────────
  ✔ Correct         : ${correct}
  ✘ Incorrect       : ${incorrect}
  ~ Partial         : ${partial}
  ──────────────────────────────────
  Strict Precision  : ${(precision * 100).toFixed(1)}%
  Soft Precision    : ${(softPrecision * 100).toFixed(1)}%   ${grade}
    `);

    if (softPrecision < 0.65) {
        console.log(`${C.red}  ⚠ KG precision is LOW. Consider:`);
        console.log(`    • Reviewing the LLM extraction prompt`);
        console.log(`    • Raising VERIFICATION_CONFIDENCE_THRESHOLD in constants.ts`);
        console.log(`    • Re-running cleanup-kg.ts to remove bad relations${C.reset}\n`);
    } else if (softPrecision < 0.85) {
        console.log(`${C.yellow}  ⚠ KG precision is MODERATE.`);
        console.log(`    Consider targeted cleanup of the ${incorrect + partial} questionable triples.${C.reset}\n`);
    } else {
        console.log(`${C.green}  ✔ KG precision is HIGH — extraction quality looks solid!${C.reset}\n`);
    }

    return { precision, softPrecision, correct, incorrect, partial, skipped, total };
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
    console.log(`\n${C.bold}${C.magenta}Study Lens — Human KG Spot-Evaluator${C.reset}`);
    console.log(`User: ${userId || 'all'}  |  Samples: ${sampleCount}\n`);

    // 1. Sample triples
    console.log(`Fetching ${sampleCount} random triples from Neo4j…`);
    let triples: Triple[] = [];
    try {
        triples = await sampleTriples(sampleCount, userId);
    } catch (e) {
        console.error(`Neo4j error: ${(e as Error).message}`);
        process.exit(1);
    }

    if (triples.length === 0) {
        console.warn('No concept→concept triples found in the KG. Upload some documents first.');
        process.exit(0);
    }

    console.log(`Found ${triples.length} triples.\n`);

    // 2. Run interactive evaluation
    const records = await runEvaluation(triples);

    if (records.length === 0) {
        console.log('No triples evaluated. Exiting.');
        process.exit(0);
    }

    // 3. Print report
    const scores = printReport(records);

    // 4. Write JSON report
    const report = {
        timestamp: new Date().toISOString(),
        userId: userId || 'all',
        sampleCount: triples.length,
        evaluated: scores.total,
        skipped: scores.skipped,
        correct: scores.correct,
        incorrect: scores.incorrect,
        partial: scores.partial,
        strictPrecision: Math.round(scores.precision * 1000) / 10,
        softPrecision: Math.round(scores.softPrecision * 1000) / 10,
        records: records.map((r) => ({
            triple: `(${r.triple.from})-[${r.triple.relType}]->(${r.triple.to})`,
            verdict: r.verdict,
            note: r.note,
        })),
    };

    const outPath = path.join(__dirname, '..', 'kg-spot-eval-report.json');
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`Report saved → ${outPath}\n`);
}

main().catch((e) => {
    console.error('Fatal error:', e);
    process.exit(1);
});