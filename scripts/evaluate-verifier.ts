#!/usr/bin/env tsx
/**
 * ═══════════════════════════════════════════════════════════════
 * STUDY LENS — Verifier Evaluation
 * ═══════════════════════════════════════════════════════════════
 *
 * Stage 2 of the verifier evaluation pipeline.
 *
 * Reads the labeled CSV produced by Stage 1 and computes:
 *   1. Binary confusion matrix at the production thresholds
 *   2. Precision / recall / F1 with positive class = "supported"
 *   3. Three-way verdict confusion matrix (a/b/c)
 *   4. Threshold sweep on the verdict-'a' confidence cutoff to show how
 *      precision / recall / F1 trade off
 *
 * Inputs:
 *   eval-output/verifier-gold.csv  — labeled by hand (see Stage 1)
 *
 * Outputs:
 *   eval-output/verifier-eval.json — machine-readable metrics
 *   stdout                          — printed report
 *
 * Usage:
 *   npx tsx scripts/evaluate-verifier.ts
 *   npx tsx scripts/evaluate-verifier.ts --csv=path/to/labeled.csv
 *
 * ═══════════════════════════════════════════════════════════════
 */

import * as fs from 'fs';
import * as path from 'path';

// ── CLI args ─────────────────────────────────────────────────
const args = process.argv.slice(2);
const csvOverride = args.find((a) => a.startsWith('--csv='))?.split('=')[1];
const defaultCsv = path.join(__dirname, '..', 'eval-output', 'verifier-gold.csv');
const csvPath = csvOverride || defaultCsv;

if (!fs.existsSync(csvPath)) {
    console.error(`Labeled CSV not found: ${csvPath}`);
    console.error(`Run Stage 1 first: npx tsx scripts/extract-gold-triples.ts --input=<file>`);
    process.exit(1);
}

// ── Colors ───────────────────────────────────────────────────
const C = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    cyan: '\x1b[36m', magenta: '\x1b[35m',
};

// ── CSV parser (handles RFC 4180 quoting) ────────────────────
function parseCsv(text: string): Record<string, string>[] {
    const rows: string[][] = [];
    let cur: string[] = [];
    let field = '';
    let inQuote = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuote) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else inQuote = false;
            } else field += ch;
        } else {
            if (ch === '"') inQuote = true;
            else if (ch === ',') { cur.push(field); field = ''; }
            else if (ch === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; }
            else if (ch === '\r') { /* skip */ }
            else field += ch;
        }
    }
    if (field !== '' || cur.length > 0) { cur.push(field); rows.push(cur); }

    if (rows.length === 0) return [];
    const headers = rows[0];
    return rows.slice(1)
        .filter((r) => r.length === headers.length && r.some((v) => v !== ''))
        .map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]])));
}

interface Row {
    triple_id: string;
    chunk_text: string;
    subject: string;
    predicate: string;
    object: string;
    verifier_verdict: string;
    verifier_confidence: number;
    production_accepted: boolean;
    human_label_binary: string;     // y / n / '' (unlabeled)
    human_label_verdict: string;    // a / b / c / '' (unlabeled)
}

function normaliseRows(raw: Record<string, string>[]): Row[] {
    return raw.map((r) => ({
        triple_id: r.triple_id,
        chunk_text: r.chunk_text,
        subject: r.subject,
        predicate: r.predicate,
        object: r.object,
        verifier_verdict: (r.verifier_verdict || '').toLowerCase().trim(),
        verifier_confidence: parseFloat(r.verifier_confidence || '0'),
        production_accepted: (r.production_accepted || '').toLowerCase() === 'true',
        human_label_binary: (r.human_label_binary || '').toLowerCase().trim(),
        human_label_verdict: (r.human_label_verdict || '').toLowerCase().trim(),
    }));
}

// ── Metric computation ───────────────────────────────────────
interface BinaryMetrics {
    tp: number; fp: number; tn: number; fn: number;
    precision: number; recall: number; f1: number; accuracy: number;
    n: number;
}

/**
 * Compute precision/recall/F1 with positive class = supported (y).
 * `predicted` is whether the verifier accepted the triple,
 * `actual` is the human's binary judgment.
 */
function binaryConfusion(rows: Array<{ predicted: boolean; actual: boolean }>): BinaryMetrics {
    let tp = 0, fp = 0, tn = 0, fn = 0;
    for (const r of rows) {
        if (r.predicted && r.actual) tp++;
        else if (r.predicted && !r.actual) fp++;
        else if (!r.predicted && r.actual) fn++;
        else tn++;
    }
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    const n = tp + fp + tn + fn;
    const accuracy = n > 0 ? (tp + tn) / n : 0;
    return { tp, fp, tn, fn, precision, recall, f1, accuracy, n };
}

// ── Display helpers ──────────────────────────────────────────
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const pad = (s: string | number, w: number) => String(s).padStart(w);
const padR = (s: string | number, w: number) => String(s).padEnd(w);

function printConfusionMatrix(m: BinaryMetrics, title: string) {
    console.log(`\n${C.bold}${title}${C.reset}`);
    console.log(`               ${C.dim}actual=y  actual=n${C.reset}`);
    console.log(`  pred=accept  ${pad(m.tp, 8)}  ${pad(m.fp, 8)}`);
    console.log(`  pred=reject  ${pad(m.fn, 8)}  ${pad(m.tn, 8)}`);
    console.log(`  ${C.dim}n = ${m.n}${C.reset}`);
    console.log(`  Precision: ${C.cyan}${pct(m.precision)}${C.reset}   Recall: ${C.cyan}${pct(m.recall)}${C.reset}   F1: ${C.cyan}${pct(m.f1)}${C.reset}   Accuracy: ${pct(m.accuracy)}`);
}

function printVerdictMatrix(rows: Row[]) {
    console.log(`\n${C.bold}Verdict Confusion Matrix (verifier rows × human cols)${C.reset}`);
    const verdicts = ['a', 'b', 'c'];
    const matrix: Record<string, Record<string, number>> = {
        a: { a: 0, b: 0, c: 0 }, b: { a: 0, b: 0, c: 0 }, c: { a: 0, b: 0, c: 0 },
    };
    let labeled = 0;
    for (const r of rows) {
        if (!verdicts.includes(r.verifier_verdict)) continue;
        if (!verdicts.includes(r.human_label_verdict)) continue;
        matrix[r.verifier_verdict][r.human_label_verdict]++;
        labeled++;
    }

    console.log(`               ${C.dim}human=a  human=b  human=c${C.reset}`);
    for (const v of verdicts) {
        console.log(`  verifier=${v}    ${pad(matrix[v].a, 5)}    ${pad(matrix[v].b, 5)}    ${pad(matrix[v].c, 5)}`);
    }
    console.log(`  ${C.dim}n labeled with verdict = ${labeled}${C.reset}`);

    // Per-verdict precision: of all triples the verifier called X, how many did the human also call X?
    console.log(`  Per-verdict precision:`);
    for (const v of verdicts) {
        const row = matrix[v];
        const total = row.a + row.b + row.c;
        const correct = row[v];
        const p = total > 0 ? correct / total : 0;
        console.log(`    verdict=${v}: ${pct(p)} (${correct}/${total})`);
    }
}

function printThresholdSweep(rows: Row[]) {
    // Sweep over the verdict-'a' confidence threshold while keeping verdict-'b'
    // threshold fixed at 0.80 (matches production). Includes the production
    // setting (0.65) plus a useful range around it.
    const thresholds = [0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90];

    console.log(`\n${C.bold}Threshold Sweep (verdict='a' cutoff; verdict='b' fixed at 0.80)${C.reset}`);
    console.log(`  ${C.dim}thr     accepted  TP   FP   TN   FN  precision  recall    F1${C.reset}`);

    const labeled = rows.filter((r) =>
        r.human_label_binary === 'y' || r.human_label_binary === 'n'
    );

    for (const thr of thresholds) {
        const evalRows = labeled.map((r) => {
            const accepted =
                (r.verifier_verdict === 'a' && r.verifier_confidence >= thr) ||
                (r.verifier_verdict === 'b' && r.verifier_confidence >= 0.80);
            return { predicted: accepted, actual: r.human_label_binary === 'y' };
        });
        const m = binaryConfusion(evalRows);
        const accepted = m.tp + m.fp;
        const marker = thr === 0.65 ? `${C.yellow} ← prod${C.reset}` : '';
        console.log(`  ${thr.toFixed(2)}    ${pad(accepted, 8)}  ${pad(m.tp, 3)}  ${pad(m.fp, 3)}  ${pad(m.tn, 3)}  ${pad(m.fn, 3)}  ${pad(pct(m.precision), 9)}  ${pad(pct(m.recall), 7)}  ${pad(pct(m.f1), 6)}${marker}`);
    }
}

// ── Main ─────────────────────────────────────────────────────
function main() {
    console.log(`${C.bold}${C.magenta}═══ Verifier Evaluation Report ═══${C.reset}`);
    console.log(`Source: ${csvPath}`);

    const text = fs.readFileSync(csvPath, 'utf-8');
    const raw = parseCsv(text);
    const all = normaliseRows(raw);
    const labeledBinary = all.filter((r) =>
        r.human_label_binary === 'y' || r.human_label_binary === 'n'
    );
    const labeledVerdict = all.filter((r) =>
        ['a', 'b', 'c'].includes(r.human_label_verdict)
    );

    console.log(`Total candidates: ${all.length}`);
    console.log(`Labeled (binary): ${labeledBinary.length}`);
    console.log(`Labeled (verdict): ${labeledVerdict.length}`);

    if (labeledBinary.length < 30) {
        console.log(`\n${C.yellow}⚠ Fewer than 30 binary labels. Metrics will be noisy.${C.reset}`);
        console.log(`  Aim for ≥100 labels for the headline numbers in your report.`);
    }

    if (labeledBinary.length === 0) {
        console.log(`\n${C.red}No labels found. Open the CSV and fill in human_label_binary first.${C.reset}`);
        process.exit(1);
    }

    // ── 1. Production-threshold confusion matrix ─────────────
    const productionRows = labeledBinary.map((r) => ({
        predicted: r.production_accepted,
        actual: r.human_label_binary === 'y',
    }));
    const productionM = binaryConfusion(productionRows);
    printConfusionMatrix(productionM, 'Binary Confusion @ Production Thresholds');
    console.log(`  ${C.dim}(production = verdict='a' & conf≥0.65, OR verdict='b' & conf≥0.80)${C.reset}`);

    // ── 2. Verdict-level matrix ──────────────────────────────
    if (labeledVerdict.length > 0) {
        printVerdictMatrix(labeledBinary.filter((r) =>
            ['a', 'b', 'c'].includes(r.human_label_verdict)
        ));
    } else {
        console.log(`\n${C.dim}(no verdict labels — skipping 3-way matrix)${C.reset}`);
    }

    // ── 3. Threshold sweep ───────────────────────────────────
    printThresholdSweep(labeledBinary);

    // ── 4. Save JSON report ──────────────────────────────────
    const outPath = path.join(path.dirname(csvPath), 'verifier-eval.json');
    const report = {
        source: csvPath,
        timestamp: new Date().toISOString(),
        n_total: all.length,
        n_labeled_binary: labeledBinary.length,
        n_labeled_verdict: labeledVerdict.length,
        production_metrics: {
            tp: productionM.tp,
            fp: productionM.fp,
            tn: productionM.tn,
            fn: productionM.fn,
            precision: productionM.precision,
            recall: productionM.recall,
            f1: productionM.f1,
            accuracy: productionM.accuracy,
        },
        threshold_sweep: [0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90].map((thr) => {
            const r = labeledBinary.map((row) => {
                const accepted =
                    (row.verifier_verdict === 'a' && row.verifier_confidence >= thr) ||
                    (row.verifier_verdict === 'b' && row.verifier_confidence >= 0.80);
                return { predicted: accepted, actual: row.human_label_binary === 'y' };
            });
            const m = binaryConfusion(r);
            return {
                threshold_a: thr,
                threshold_b: 0.80,
                ...m,
            };
        }),
    };
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');
    console.log(`\n${C.green}✔${C.reset} Machine-readable report: ${outPath}`);
}

main();