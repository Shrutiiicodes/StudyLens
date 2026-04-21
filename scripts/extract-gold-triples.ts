#!/usr/bin/env tsx
/**
 * ═══════════════════════════════════════════════════════════════
 * STUDY LENS — Verifier Gold Set Extraction
 * ═══════════════════════════════════════════════════════════════
 *
 * Stage 1 of the verifier evaluation pipeline.
 *
 * Runs the production extract + verify path on a known input file and
 * dumps every candidate triple (with chunk text and verifier output) to
 * a CSV. You then label the CSV by hand. Stage 2 (`evaluate-verifier.ts`)
 * reads the labels back and computes precision/recall/F1.
 *
 * Why this design:
 *   - Reproducible: same input → same triples (modulo extractor
 *     non-determinism, which we mitigate with temperature=0.2 as in prod).
 *   - Honest: uses the exact same prompts and models the production
 *     pipeline does, so the metrics you publish reflect real behaviour.
 *   - Cheap: hand-labeling 100 triples takes ~30 minutes.
 *
 * Usage:
 *   npx tsx scripts/extract-gold-triples.ts --input=path/to/doc.pdf
 *   npx tsx scripts/extract-gold-triples.ts --input=path/to/doc.txt --target=100
 *   npx tsx scripts/extract-gold-triples.ts --input=doc.pdf --max-chunks=20
 *
 * Output:
 *   eval-output/verifier-gold.csv    — open in Excel / Google Sheets,
 *                                      fill in human_label_binary
 *                                      (y/n) and human_label_verdict
 *                                      (a/b/c) for each row.
 *   eval-output/verifier-gold.json   — same data, programmatic copy.
 *
 * ═══════════════════════════════════════════════════════════════
 *
 * Drift warning: the prompt strings and threshold logic below MUST stay
 * in sync with src/lib/kg-builder.ts. If you change one, change both.
 * The prompts are inlined here (rather than imported) because kg-builder
 * doesn't currently export them as a constant — refactor candidate.
 * ═══════════════════════════════════════════════════════════════
 */

import * as fs from 'fs';
import * as path from 'path';
import Groq from 'groq-sdk';

// ── Load .env.local ──────────────────────────────────────────
function loadEnv() {
    const envPath = path.join(__dirname, '..', '.env.local');
    if (!fs.existsSync(envPath)) {
        console.error('.env.local not found — create it with GROQ_API_KEY');
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
const inputPath = args.find((a) => a.startsWith('--input='))?.split('=')[1];
const target = parseInt(
    args.find((a) => a.startsWith('--target='))?.split('=')[1] || '120',
    10,
);
const maxChunks = parseInt(
    args.find((a) => a.startsWith('--max-chunks='))?.split('=')[1] || '15',
    10,
);

if (!inputPath) {
    console.error('Usage: npx tsx scripts/extract-gold-triples.ts --input=<file>');
    console.error('       --target=120     candidates to extract (default 120)');
    console.error('       --max-chunks=15  cap on chunks processed (default 15)');
    process.exit(1);
}

if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
}

// ── Models — must match production (src/lib/kg-builder.ts) ───
const EXTRACTOR_MODEL = 'qwen/qwen3-32b';
const VERIFIER_MODEL = 'llama-3.1-8b-instant';

// ── Colors ───────────────────────────────────────────────────
const C = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    cyan: '\x1b[36m', magenta: '\x1b[35m',
};
const log = (msg: string) => console.log(msg);
const ok = (msg: string) => console.log(`  ${C.green}✔${C.reset} ${msg}`);
const dim = (msg: string) => console.log(`  ${C.dim}${msg}${C.reset}`);

// ── Groq client ──────────────────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });

// ── Types ────────────────────────────────────────────────────
interface RawTriple {
    from: string;
    type: string;
    to: string;
}

interface VerifierOutput {
    verdict: 'a' | 'b' | 'c' | 'unknown';
    confidence: number;
    raw_response: string;
}

interface GoldRow {
    triple_id: string;
    chunk_id: number;
    chunk_text: string;
    subject: string;
    predicate: string;
    object: string;
    verifier_verdict: string;       // a / b / c / unknown
    verifier_confidence: number;
    verifier_model: string;
    extractor_model: string;
    // Production accept/reject — the same logic as kg-builder.ts.
    // (a, conf >= 0.65) OR (b, conf >= 0.80) → accept.
    production_accepted: boolean;
    // Empty fields for the human labeller.
    human_label_binary: '';         // y or n — is the triple supported?
    human_label_verdict: '';        // a, b, or c — which verdict do you give?
    human_notes: '';
}

// ── PDF / text loader ────────────────────────────────────────
async function loadInputText(filePath: string): Promise<string> {
    const ext = path.extname(filePath).toLowerCase();
    const buffer = fs.readFileSync(filePath);

    if (ext === '.txt') {
        return buffer.toString('utf-8');
    }

    if (ext === '.pdf') {
        // Match the production extractor in src/app/api/upload/route.ts
        const { PDFParse } = await import('pdf-parse');
        const parser = new PDFParse({ data: buffer });
        const pdfData = await parser.getText();
        await parser.destroy();
        return pdfData.text;
    }

    throw new Error(`Unsupported input type: ${ext} (use .pdf or .txt)`);
}

// ── Chunker — same defaults as production (src/lib/embeddings.ts) ──
function chunkText(text: string, chunkSize = 1000, overlap = 150): string[] {
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
        const end = Math.min(start + chunkSize, text.length);
        const slice = text.slice(start, end).trim();
        if (slice.length >= 50) chunks.push(slice);
        if (end >= text.length) break;
        start = end - overlap;
    }
    return chunks;
}

// ── Extractor prompt — copied from src/config/prompts.ts ─────
// We DO NOT import here so the script remains a self-contained snapshot
// of what was evaluated. If you tweak the production prompt, run the
// extraction again to refresh the gold set.
const EXTRACTOR_SYSTEM = `You are an expert knowledge extractor for scientific and educational content.
Given a text chunk, extract all critical concepts, their definitions, and their inter-relationships.

Respond ONLY with valid JSON of the form:
{
  "concepts": [{ "name": "...", "definition": "...", "examples": [], "formulas": [], "misconceptions": [] }],
  "relationships": [{ "from": "...", "to": "...", "type": "..." }]
}

Allowed relationship types: IS_A | REQUIRES | PART_OF | USED_FOR | RELATES_TO |
CAUSES | DEFINES | CONTRASTS_WITH | EXAMPLE_OF | FEATURE_OF | PRECEDES |
EXTENSION_OF | FOUND_IN | LOCATED_IN | CONTAINS | CHARACTERIZED_BY |
DISCOVERED_BY | BUILT_BY | PRODUCED_BY | SUPPLIED_BY | TRADED_BY | LED_TO`;

const VERIFIER_SYSTEM = `You are a fact-verification assistant for educational content.
Given a source passage and a factual triple, determine if the triple is
directly and explicitly supported by the passage.

Respond ONLY with JSON: {"verdict": "a" | "b" | "c", "confidence": 0.0-1.0}

Verdicts:
(a) Directly and explicitly stated in the passage
(b) Implied or inferred — not directly stated
(c) Not supported or contradicted`;

// ── Extractor call ───────────────────────────────────────────
async function extractTriples(chunk: string): Promise<RawTriple[]> {
    try {
        const response = await groq.chat.completions.create({
            model: EXTRACTOR_MODEL,
            temperature: 0.2,
            max_tokens: 2048,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: EXTRACTOR_SYSTEM },
                { role: 'user', content: chunk },
            ],
        });
        const raw = response.choices[0]?.message?.content || '{}';
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed.relationships) ? parsed.relationships : [];
    } catch (err) {
        console.warn(`  Extractor error: ${(err as Error).message}`);
        return [];
    }
}

// ── Verifier call ────────────────────────────────────────────
async function verifyTriple(triple: RawTriple, chunk: string): Promise<VerifierOutput> {
    try {
        const response = await groq.chat.completions.create({
            model: VERIFIER_MODEL,
            temperature: 0.1,
            max_tokens: 256,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: VERIFIER_SYSTEM },
                {
                    role: 'user', content: `Passage: "${chunk}"

Triple to verify: (${triple.from}, ${triple.type}, ${triple.to})

Is this triple directly supported by the passage?` },
            ],
        });
        const raw = response.choices[0]?.message?.content || '{}';
        const parsed = JSON.parse(raw);
        const verdict = ['a', 'b', 'c'].includes(parsed.verdict) ? parsed.verdict : 'unknown';
        const confidence = typeof parsed.confidence === 'number'
            ? Math.max(0, Math.min(1, parsed.confidence))
            : 0;
        return { verdict, confidence, raw_response: raw };
    } catch (err) {
        return { verdict: 'unknown', confidence: 0, raw_response: `ERROR: ${(err as Error).message}` };
    }
}

// ── Production accept/reject — match src/lib/kg-builder.ts ───
function isProductionAccepted(verdict: string, confidence: number): boolean {
    return (verdict === 'a' && confidence >= 0.65)
        || (verdict === 'b' && confidence >= 0.80);
}

// ── CSV writer (RFC 4180 — escape quotes, wrap fields) ───────
function csvEscape(value: unknown): string {
    const s = value === null || value === undefined ? '' : String(value);
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}

function rowsToCsv(rows: GoldRow[]): string {
    if (rows.length === 0) return '';
    const headers = Object.keys(rows[0]) as (keyof GoldRow)[];
    const lines = [headers.join(',')];
    for (const row of rows) {
        lines.push(headers.map((h) => csvEscape(row[h])).join(','));
    }
    return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
    log(`${C.bold}${C.magenta}═══ Verifier Gold Set Extraction ═══${C.reset}`);
    log(`Input:        ${inputPath}`);
    log(`Target:       ${target} candidates`);
    log(`Max chunks:   ${maxChunks}`);
    log(`Extractor:    ${EXTRACTOR_MODEL}`);
    log(`Verifier:     ${VERIFIER_MODEL}`);
    log('');

    // ── 1. Load + chunk ──────────────────────────────────────
    log(`${C.cyan}1. Loading and chunking...${C.reset}`);
    const fullText = await loadInputText(inputPath!);
    const allChunks = chunkText(fullText);
    const chunks = allChunks.slice(0, maxChunks);
    ok(`${allChunks.length} total chunks; processing ${chunks.length}`);

    // ── 2. Extract + verify per chunk until target hit ───────
    log(`\n${C.cyan}2. Extracting + verifying...${C.reset}`);
    const rows: GoldRow[] = [];
    let chunkIdx = 0;

    for (const chunk of chunks) {
        chunkIdx++;
        if (rows.length >= target) {
            dim(`Hit target of ${target}; stopping at chunk ${chunkIdx}/${chunks.length}`);
            break;
        }
        dim(`Chunk ${chunkIdx}/${chunks.length} (${chunk.length} chars)...`);

        const triples = await extractTriples(chunk);
        if (triples.length === 0) {
            dim(`  no triples extracted`);
            continue;
        }
        dim(`  ${triples.length} triples extracted; verifying...`);

        for (const triple of triples) {
            if (rows.length >= target) break;

            // Skip degenerate triples that would never reach the verifier
            // in production (self-loops are filtered downstream anyway).
            if (!triple.from || !triple.to || !triple.type) continue;
            if (triple.from.toLowerCase().trim() === triple.to.toLowerCase().trim()) continue;

            const v = await verifyTriple(triple, chunk);
            const accepted = isProductionAccepted(v.verdict, v.confidence);

            rows.push({
                triple_id: `t${String(rows.length + 1).padStart(4, '0')}`,
                chunk_id: chunkIdx,
                chunk_text: chunk,
                subject: triple.from,
                predicate: triple.type,
                object: triple.to,
                verifier_verdict: v.verdict,
                verifier_confidence: Math.round(v.confidence * 1000) / 1000,
                verifier_model: VERIFIER_MODEL,
                extractor_model: EXTRACTOR_MODEL,
                production_accepted: accepted,
                human_label_binary: '',
                human_label_verdict: '',
                human_notes: '',
            });
        }
        ok(`  cumulative: ${rows.length}/${target}`);
    }

    // ── 3. Write output ──────────────────────────────────────
    const outDir = path.join(__dirname, '..', 'eval-output');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const csvPath = path.join(outDir, 'verifier-gold.csv');
    const jsonPath = path.join(outDir, 'verifier-gold.json');

    fs.writeFileSync(csvPath, rowsToCsv(rows), 'utf-8');
    fs.writeFileSync(jsonPath, JSON.stringify(rows, null, 2), 'utf-8');

    log('');
    log(`${C.bold}${C.green}═══ Done ═══${C.reset}`);
    ok(`${rows.length} candidate triples written`);
    ok(`CSV:  ${csvPath}`);
    ok(`JSON: ${jsonPath}`);
    log('');
    log(`${C.cyan}Next steps:${C.reset}`);
    log(`  1. Open the CSV in your spreadsheet app.`);
    log(`  2. For each row, read chunk_text and decide:`);
    log(`     - human_label_binary:  y if the triple is supported by the chunk, n if not`);
    log(`     - human_label_verdict: a (directly stated) / b (implied) / c (unsupported)`);
    log(`  3. Run: npx tsx scripts/evaluate-verifier.ts`);
}

main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});