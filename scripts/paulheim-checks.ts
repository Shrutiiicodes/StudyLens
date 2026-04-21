/**
 * ═══════════════════════════════════════════════════════════════
 * STUDY LENS — Paulheim KG Quality Evaluation
 * ═══════════════════════════════════════════════════════════════
 *
 * Implements the three canonical KG-refinement dimensions from
 *
 *   Paulheim, H. (2017). Knowledge graph refinement: A survey of
 *   approaches and evaluation methods. Semantic Web, 8(3), 489–508.
 *
 * Exposed as an optional section in scripts/evaluate-kg.ts via the
 * --paulheim flag. The three metrics are reported as percentages so
 * they drop cleanly into a report table:
 *
 *   ┌────────────────────┬──────────────────────┬────────────────┐
 *   │ Dimension          │ Metric               │ Value          │
 *   ├────────────────────┼──────────────────────┼────────────────┤
 *   │ Accuracy           │ Verifier reacceptance│ P %            │
 *   │ Completeness       │ Entity coverage      │ C %            │
 *   │ Consistency        │ 1 − contradiction    │ (1 − Xrate) %  │
 *   └────────────────────┴──────────────────────┴────────────────┘
 *
 * Design notes
 * ------------
 * 1. ACCURACY — the production verifier is the arbiter of what enters
 *    the graph, so "graph precision" measured against that verifier is
 *    ~100% by construction. To get a meaningful signal we re-run the
 *    verifier on a sampled subset of already-accepted triples and count
 *    how many it now rejects. This catches:
 *      - Verifier non-determinism (run-to-run variance)
 *      - Stale triples whose source chunk no longer supports them
 *      - Changes in the verifier prompt since the triples were written
 *
 *    For a separate precision-against-human-gold number, use the
 *    verifier-eval harness (scripts/extract-gold-triples.ts +
 *    scripts/evaluate-verifier.ts).
 *
 * 2. COMPLETENESS — the spec calls for spaCy NER on source chunks.
 *    This module uses a dependency-free heuristic (capitalised multi-
 *    word phrases + technical terms, filtered by a short stopword list)
 *    since spaCy is not a project dependency. The methodology doc
 *    explains how to swap in spaCy if you want tighter NER.
 *
 *    Coverage = |candidates matched to concept nodes| / |candidates|
 *    Sampled across N source chunks (default 30).
 *
 * 3. CONSISTENCY — no NOT_* predicates exist in the ontology, so
 *    contradictions are measured structurally:
 *      a) Bidirectional same-type edges  (A IS_A B AND B IS_A A)
 *      b) Cycles in hierarchical relations (IS_A, PART_OF, PRECEDES,
 *         REQUIRES) — these MUST be DAGs by definition
 *      c) Mutually-exclusive type pairs on the same concept pair
 *         (small hand-curated list — extend in CONTRADICTORY_PAIRS)
 *
 *    Contradiction rate = contradictory edges / total edges.
 *    Consistency score  = (1 − contradiction rate) × 100.
 * ═══════════════════════════════════════════════════════════════
 */

import { Session, Integer } from 'neo4j-driver';
import Groq from 'groq-sdk';

// ─── Shared result type (matches evaluate-kg.ts's CheckResult) ───
export interface PaulheimResult {
    name: string;
    passed: boolean;
    score: number;       // 0–100
    details: string;
    issues?: string[];
    // Full breakdown so the report can reference sub-metrics.
    extras?: Record<string, unknown>;
}

// ─── Small logger matching the parent script's style ──────────
const C = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    cyan: '\x1b[36m', magenta: '\x1b[35m',
};
function subheader(msg: string) {
    const line = '─'.repeat(50);
    console.log(`\n${C.cyan}${line}${C.reset}`);
    console.log(`${C.bold}${C.cyan}  ${msg}${C.reset}`);
    console.log(`${C.cyan}${line}${C.reset}`);
}
function line(icon: string, color: string, msg: string) {
    console.log(`  ${color}${icon}${C.reset}  ${msg}`);
}
const ok = (m: string) => line('✔', C.green, m);
const warn = (m: string) => line('⚠', C.yellow, m);
const info = (m: string) => line('ℹ', C.cyan, m);
const dim = (m: string) => console.log(`    ${C.dim}${m}${C.reset}`);
const metric = (label: string, value: string) =>
    console.log(`  ${C.cyan}◈${C.reset}  ${label.padEnd(30)} ${C.bold}${value}${C.reset}`);

function toNum(val: unknown): number {
    if (val === null || val === undefined) return 0;
    if (typeof val === 'number') return val;
    if (Integer.isInteger(val as Integer)) return (val as Integer).toNumber();
    return Number(val);
}

async function runQ<T = Record<string, unknown>>(
    session: Session,
    query: string,
    params: Record<string, unknown> = {},
): Promise<T[]> {
    const result = await session.run(query, params);
    return result.records.map((r) => {
        const obj: Record<string, unknown> = {};
        r.keys.forEach((k) => {
            obj[k as string] = r.get(k);
        });
        return obj as T;
    });
}

// ═══════════════════════════════════════════════════════════════
// DIMENSION 1 — ACCURACY (Verifier reacceptance rate)
// ═══════════════════════════════════════════════════════════════

const VERIFIER_MODEL = 'llama-3.1-8b-instant';
const VERIFIER_SYSTEM = `You are a fact-verification assistant for educational content.
Given a source passage and a factual triple, determine if the triple is
directly and explicitly supported by the passage.

Respond ONLY with JSON: {"verdict": "a" | "b" | "c", "confidence": 0.0-1.0}

Verdicts:
(a) Directly and explicitly stated in the passage
(b) Implied or inferred — not directly stated
(c) Not supported or contradicted`;

// Production threshold, matching src/lib/kg-builder.ts
function productionAccept(verdict: string, confidence: number): boolean {
    return (verdict === 'a' && confidence >= 0.65)
        || (verdict === 'b' && confidence >= 0.80);
}

export async function checkPaulheimAccuracy(
    session: Session,
    userId: string | undefined,
    sampleSize: number,
): Promise<PaulheimResult> {
    subheader('Paulheim 1/3 — Accuracy (verifier reacceptance rate)');

    if (!process.env.GROQ_API_KEY) {
        warn('GROQ_API_KEY not set — skipping accuracy check');
        return {
            name: 'Paulheim: Accuracy',
            passed: false,
            score: 0,
            details: 'Skipped — GROQ_API_KEY missing',
        };
    }

    // 1. Sample already-accepted triples with their source chunk.
    //    Only Concept→Concept edges that have a non-empty sourceChunk
    //    on either endpoint (needed to re-verify).
    const filter = userId ? `{userId: $userId}` : '';
    const params: Record<string, unknown> = userId ? { userId, sample: sampleSize } : { sample: sampleSize };

    const triples = await runQ<{
        from: string;
        to: string;
        relType: string;
        chunk: string;
    }>(
        session,
        `MATCH (a:Concept ${filter})-[r]->(b:Concept ${filter})
         WHERE a <> b
           AND (a.sourceChunk IS NOT NULL AND a.sourceChunk <> '')
         RETURN a.name AS from,
                b.name AS to,
                type(r) AS relType,
                a.sourceChunk AS chunk
         ORDER BY rand()
         LIMIT $sample`,
        params,
    );

    if (triples.length === 0) {
        warn('No triples with sourceChunk found — skipping');
        return {
            name: 'Paulheim: Accuracy',
            passed: false,
            score: 0,
            details: 'No triples with sourceChunk available',
        };
    }

    info(`Sampling ${triples.length} triples for re-verification...`);

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    let accepted = 0;
    let rejected = 0;
    const rejectedExamples: Array<{ from: string; rel: string; to: string; verdict: string; confidence: number }> = [];

    for (const t of triples) {
        try {
            const resp = await groq.chat.completions.create({
                model: VERIFIER_MODEL,
                temperature: 0.1,
                max_tokens: 256,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: VERIFIER_SYSTEM },
                    {
                        role: 'user',
                        content: `Passage: "${t.chunk}"\n\nTriple to verify: (${t.from}, ${t.relType}, ${t.to})\n\nIs this triple directly supported by the passage?`,
                    },
                ],
            });
            const raw = resp.choices[0]?.message?.content || '{}';
            const parsed = JSON.parse(raw);
            const verdict = ['a', 'b', 'c'].includes(parsed.verdict) ? parsed.verdict : 'c';
            const conf = typeof parsed.confidence === 'number'
                ? Math.max(0, Math.min(1, parsed.confidence))
                : 0;
            if (productionAccept(verdict, conf)) accepted++;
            else {
                rejected++;
                if (rejectedExamples.length < 5) {
                    rejectedExamples.push({
                        from: t.from, rel: t.relType, to: t.to,
                        verdict, confidence: Math.round(conf * 100) / 100,
                    });
                }
            }
        } catch (err) {
            dim(`Skipped (error): (${t.from}, ${t.relType}, ${t.to})`);
        }
    }

    const n = accepted + rejected;
    const reacceptance = n > 0 ? (accepted / n) * 100 : 0;

    metric('Triples sampled', String(n));
    metric('Re-accepted', String(accepted));
    metric('Re-rejected', String(rejected));
    metric('Reacceptance rate', `${reacceptance.toFixed(1)}%`);

    if (rejectedExamples.length > 0) {
        dim(`Examples now rejected by verifier:`);
        for (const ex of rejectedExamples) {
            dim(`  (${ex.from}, ${ex.rel}, ${ex.to}) → verdict=${ex.verdict}, conf=${ex.confidence}`);
        }
    }

    const issues: string[] = [];
    if (reacceptance < 85) {
        issues.push(`Verifier re-rejects ${rejected}/${n} graph triples — consider re-running the pipeline with the current verifier prompt`);
    }

    return {
        name: 'Paulheim: Accuracy',
        passed: reacceptance >= 85,
        score: reacceptance,
        details: `${accepted}/${n} graph triples still pass the verifier`,
        issues,
        extras: {
            n_sampled: n,
            accepted,
            rejected,
            reacceptance_rate: reacceptance / 100,
            rejected_examples: rejectedExamples,
        },
    };
}

// ═══════════════════════════════════════════════════════════════
// DIMENSION 2 — COMPLETENESS (Entity coverage ratio)
// ═══════════════════════════════════════════════════════════════

// Very short stopword list — these are the words most likely to get
// capitalised at sentence starts and falsely picked up as entities.
const STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'so', 'of',
    'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'as', 'is',
    'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had',
    'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them',
    'we', 'our', 'you', 'your', 'he', 'she', 'his', 'her', 'their',
    'there', 'here', 'when', 'where', 'what', 'which', 'who', 'whom',
    'why', 'how', 'one', 'two', 'three', 'first', 'second', 'third',
    'chapter', 'section', 'figure', 'fig', 'table', 'page',
    'however', 'therefore', 'thus', 'hence', 'moreover', 'furthermore',
]);

/**
 * Candidate noun-phrase extractor — dependency-free heuristic.
 *
 * Captures the kinds of surface forms that typically become Concept
 * nodes in this graph: proper nouns (single or multi-word, e.g.
 * "Mohenjodaro", "Great Bath", "Indus Valley") and capitalised
 * technical terms. This is noisier than spaCy NER — it will miss
 * some concepts and include some false positives — but for a
 * coverage metric that answers "roughly what fraction of named
 * things in the source became nodes?" it's adequate and reproducible.
 *
 * If you install spaCy and swap in its NER output, the metric
 * definition doesn't change — it's still |matched| / |candidates|.
 */
export function extractCandidateEntities(text: string): string[] {
    if (!text) return [];

    // Strip trivial formatting chars that break regexes
    const cleaned = text.replace(/[\r\n\t]+/g, ' ');

    // Match sequences of 1+ capitalised words, optionally with
    // lowercase connectors (of, and, the) in the middle.
    // e.g. "Great Bath", "Harappan Civilization", "Kingdom of Magadha"
    const re = /\b[A-Z][a-zA-Z]+(?:\s+(?:[A-Z][a-zA-Z]+|of|and|the|de|la|du|von|der))*\b/g;
    const matches = cleaned.match(re) || [];

    // Connectors we allowed INSIDE a phrase but must strip from the
    // edges — "The Great Bath" → "Great Bath", "Indus Valley and" → "Indus Valley".
    const edgeConnectors = new Set(['the', 'a', 'an', 'of', 'and', 'de', 'la', 'du', 'von', 'der']);

    const trimConnectors = (phrase: string): string => {
        let words = phrase.split(/\s+/);
        while (words.length > 0 && edgeConnectors.has(words[0].toLowerCase())) {
            words.shift();
        }
        while (words.length > 0 && edgeConnectors.has(words[words.length - 1].toLowerCase())) {
            words.pop();
        }
        return words.join(' ');
    };

    // Normalise + dedupe
    const seen = new Set<string>();
    const out: string[] = [];

    // Emit the full phrase AND any sub-phrases that split on lowercase
    // connectors. "Great Bath of Mohenjodaro" → [the whole phrase,
    // "Great Bath", "Mohenjodaro"]. This is because the graph may have
    // stored the parts as separate Concept nodes.
    const emit = (phrase: string) => {
        if (!phrase) return;
        const parts = phrase.split(/\s+/);
        if (parts.length === 1) {
            if (phrase.length <= 2) return;
            if (STOPWORDS.has(phrase.toLowerCase())) return;
        }
        const key = phrase.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            out.push(phrase);
        }
    };

    for (const raw of matches) {
        const full = trimConnectors(raw.trim());
        if (!full) continue;
        emit(full);

        // Split on lowercase connectors and also emit each capitalised run.
        // "Great Bath of Mohenjodaro" → connectors at index 2 (of),
        // producing runs "Great Bath" and "Mohenjodaro".
        const tokens = full.split(/\s+/);
        let current: string[] = [];
        for (const tok of tokens) {
            if (edgeConnectors.has(tok.toLowerCase())) {
                if (current.length > 0) emit(current.join(' '));
                current = [];
            } else {
                current.push(tok);
            }
        }
        if (current.length > 0 && current.length < tokens.length) {
            // Only emit the trailing run if we actually saw a split
            // (otherwise it's identical to `full`, already emitted).
            emit(current.join(' '));
        }
    }
    return out;
}

// Canonical match: lowercase, strip punctuation, collapse whitespace.
// Must match the behaviour of src/lib/kg-builder.ts → canonicalizeName
// loosely enough that we don't penalise the graph for minor tokenisation
// differences ("Great Bath" vs "great bath"), but strict enough that
// "Mohenjodaro" and "Mesopotamia" don't conflate.
function canonicalise(name: string): string {
    return (name || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

export async function checkPaulheimCompleteness(
    session: Session,
    userId: string | undefined,
    chunkSampleSize: number,
): Promise<PaulheimResult> {
    subheader('Paulheim 2/3 — Completeness (entity coverage ratio)');

    // 1. Fetch the universe of concept names in the graph (for lookup)
    const filter = userId ? `{userId: $userId}` : '';
    const params: Record<string, unknown> = userId ? { userId, sample: chunkSampleSize } : { sample: chunkSampleSize };

    const allConcepts = await runQ<{ name: string }>(
        session,
        `MATCH (c:Concept ${filter}) RETURN c.name AS name`,
        userId ? { userId } : {},
    );
    const conceptIndex = new Set(allConcepts.map((c) => canonicalise(c.name)));
    info(`Concept index: ${conceptIndex.size} nodes`);

    if (conceptIndex.size === 0) {
        warn('No concepts in graph — skipping');
        return {
            name: 'Paulheim: Completeness',
            passed: false,
            score: 0,
            details: 'No concept nodes found',
        };
    }

    // 2. Sample distinct source chunks from the graph
    const chunks = await runQ<{ chunk: string }>(
        session,
        `MATCH (c:Concept ${filter})
         WHERE c.sourceChunk IS NOT NULL AND c.sourceChunk <> ''
         WITH DISTINCT c.sourceChunk AS chunk
         ORDER BY rand()
         LIMIT $sample`,
        params,
    );

    if (chunks.length === 0) {
        warn('No source chunks found on concepts — skipping');
        return {
            name: 'Paulheim: Completeness',
            passed: false,
            score: 0,
            details: 'No sourceChunk data available',
        };
    }

    info(`Sampling ${chunks.length} source chunks`);

    // 3. Extract candidates per chunk, check against concept index
    let totalCandidates = 0;
    let matchedCandidates = 0;
    const missedExamples: string[] = [];

    for (const { chunk } of chunks) {
        const candidates = extractCandidateEntities(chunk);
        totalCandidates += candidates.length;
        for (const cand of candidates) {
            const canon = canonicalise(cand);
            // Match as substring either way — the graph may store the phrase
            // as a longer or shorter variant of what's in the text.
            let matched = conceptIndex.has(canon);
            if (!matched) {
                for (const node of conceptIndex) {
                    if (node.includes(canon) || canon.includes(node)) {
                        matched = true;
                        break;
                    }
                }
            }
            if (matched) matchedCandidates++;
            else if (missedExamples.length < 10) missedExamples.push(cand);
        }
    }

    const coverage = totalCandidates > 0
        ? (matchedCandidates / totalCandidates) * 100
        : 0;

    metric('Chunks sampled', String(chunks.length));
    metric('Candidate entities', String(totalCandidates));
    metric('Matched to concept nodes', String(matchedCandidates));
    metric('Entity coverage ratio', `${coverage.toFixed(1)}%`);

    if (missedExamples.length > 0) {
        dim(`Examples NOT in concept index:`);
        for (const m of missedExamples.slice(0, 8)) dim(`  "${m}"`);
    }

    const issues: string[] = [];
    if (coverage < 60) {
        issues.push(`Entity coverage (${coverage.toFixed(1)}%) is below Paulheim's 60% target`);
    }

    return {
        name: 'Paulheim: Completeness',
        passed: coverage >= 60,
        score: coverage,
        details: `${matchedCandidates}/${totalCandidates} source entities present as concept nodes`,
        issues,
        extras: {
            concept_index_size: conceptIndex.size,
            chunks_sampled: chunks.length,
            total_candidates: totalCandidates,
            matched_candidates: matchedCandidates,
            coverage_ratio: coverage / 100,
            missed_examples: missedExamples.slice(0, 20),
        },
    };
}

// ═══════════════════════════════════════════════════════════════
// DIMENSION 3 — CONSISTENCY (Contradiction rate)
// ═══════════════════════════════════════════════════════════════

// Relation types that should form a DAG — cycles in these are
// definitional contradictions. (X IS_A Y AND Y IS_A X cannot both hold.)
const DAG_RELATIONS = ['IS_A', 'PART_OF', 'PRECEDES', 'REQUIRES', 'EXTENSION_OF'];

// Mutually-exclusive relation pairs: if (A, X, B) exists AND (A, Y, B) also
// exists AND X,Y appear in the same pair group, that's a contradiction.
// Kept short on purpose — widen as specific bad patterns emerge.
const CONTRADICTORY_PAIRS: [string, string][] = [
    ['IS_A', 'CONTRASTS_WITH'],
    ['PART_OF', 'CONTAINS'],      // reversed direction handled below
    ['CAUSES', 'CAUSED_BY'],       // reversed direction handled below
    ['EXAMPLE_OF', 'CONTRASTS_WITH'],
];

export async function checkPaulheimConsistency(
    session: Session,
    userId: string | undefined,
): Promise<PaulheimResult> {
    subheader('Paulheim 3/3 — Consistency (contradiction rate)');

    const filter = userId ? `{userId: $userId}` : '';
    const params = userId ? { userId } : {};

    // 0. Total edges (Concept→Concept only — sub-nodes don't count)
    const [totalRow] = await runQ<{ n: unknown }>(
        session,
        `MATCH (a:Concept ${filter})-[r]->(b:Concept ${filter})
         WHERE a <> b
         RETURN count(r) AS n`,
        params,
    );
    const totalEdges = toNum(totalRow?.n);
    metric('Total Concept→Concept edges', String(totalEdges));

    if (totalEdges === 0) {
        warn('No concept-to-concept edges — nothing to evaluate');
        return {
            name: 'Paulheim: Consistency',
            passed: true,
            score: 100,
            details: 'No edges to evaluate',
            extras: { contradictions: 0, total_edges: 0 },
        };
    }

    // 1. Bidirectional same-type relations
    const [bidirRow] = await runQ<{ n: unknown }>(
        session,
        `MATCH (a:Concept ${filter})-[r1]->(b:Concept ${filter}),
               (b)-[r2]->(a)
         WHERE a <> b AND type(r1) = type(r2) AND id(r1) < id(r2)
         RETURN count(r1) AS n`,
        params,
    );
    const bidirPairs = toNum(bidirRow?.n);
    const bidirEdges = bidirPairs * 2; // one bidir pair = 2 contradictory edges
    metric('Bidirectional same-type pairs', String(bidirPairs));

    // 2. Cycles in DAG relations (length 2-5)
    let dagCycleEdges = 0;
    const dagCycleExamples: string[] = [];
    for (const rel of DAG_RELATIONS) {
        const cycleRows = await runQ<{ names: string[] }>(
            session,
            `MATCH p = (a:Concept ${filter})-[:${rel}*2..5]->(a)
             RETURN [n IN nodes(p) | n.name] AS names
             LIMIT 20`,
            params,
        );
        for (const row of cycleRows) {
            // Count edges in this cycle — a cycle of length k has k edges.
            const edgesInCycle = Math.max(0, row.names.length - 1);
            dagCycleEdges += edgesInCycle;
            if (dagCycleExamples.length < 5) {
                dagCycleExamples.push(`${rel}: ${row.names.join(' → ')}`);
            }
        }
    }
    metric('Edges in DAG-relation cycles', String(dagCycleEdges));

    // 3. Mutually-exclusive type pairs on the same pair of concepts
    let mutexEdges = 0;
    const mutexExamples: string[] = [];
    for (const [x, y] of CONTRADICTORY_PAIRS) {
        // Same direction (A x B AND A y B)
        const sameDir = await runQ<{ from: string; to: string }>(
            session,
            `MATCH (a:Concept ${filter})-[r1:${x}]->(b:Concept ${filter}),
                   (a)-[r2:${y}]->(b)
             WHERE a <> b
             RETURN a.name AS from, b.name AS to
             LIMIT 10`,
            params,
        );
        // Reversed direction (A x B AND B y A) — covers PART_OF/CONTAINS and CAUSES/CAUSED_BY
        const revDir = await runQ<{ from: string; to: string }>(
            session,
            `MATCH (a:Concept ${filter})-[r1:${x}]->(b:Concept ${filter}),
                   (b)-[r2:${y}]->(a)
             WHERE a <> b
             RETURN a.name AS from, b.name AS to
             LIMIT 10`,
            params,
        );
        // Each pair contributes 2 contradictory edges (one from each side).
        mutexEdges += (sameDir.length + revDir.length) * 2;
        for (const row of [...sameDir.slice(0, 2), ...revDir.slice(0, 2)]) {
            if (mutexExamples.length < 5) {
                mutexExamples.push(`${row.from} ${x}/${y} ${row.to}`);
            }
        }
    }
    metric('Edges in mutex type pairs', String(mutexEdges));

    // 4. Total contradiction count + rate
    // NOTE: we cap at totalEdges to prevent the rate going >1 in
    // pathological cases (e.g. same edge counted by two rules).
    const contradictoryEdges = Math.min(
        totalEdges,
        bidirEdges + dagCycleEdges + mutexEdges,
    );
    const contradictionRate = contradictoryEdges / totalEdges;
    const consistencyScore = (1 - contradictionRate) * 100;

    metric('Total contradictory edges', String(contradictoryEdges));
    metric('Contradiction rate', `${(contradictionRate * 100).toFixed(2)}%`);
    metric('Consistency score', `${consistencyScore.toFixed(1)}%`);

    if (dagCycleExamples.length > 0) {
        dim(`DAG cycle examples:`);
        for (const e of dagCycleExamples) dim(`  ${e}`);
    }
    if (mutexExamples.length > 0) {
        dim(`Mutex type pair examples:`);
        for (const e of mutexExamples) dim(`  ${e}`);
    }

    const issues: string[] = [];
    if (contradictionRate > 0.02) {
        issues.push(`Contradiction rate (${(contradictionRate * 100).toFixed(2)}%) exceeds 2% — inspect cleanup-kg.ts output`);
    }

    return {
        name: 'Paulheim: Consistency',
        passed: contradictionRate <= 0.02,
        score: consistencyScore,
        details: `${contradictoryEdges}/${totalEdges} edges flagged as contradictory`,
        issues,
        extras: {
            total_edges: totalEdges,
            bidirectional_pairs: bidirPairs,
            dag_cycle_edges: dagCycleEdges,
            mutex_edges: mutexEdges,
            contradictory_edges: contradictoryEdges,
            contradiction_rate: contradictionRate,
            consistency_score: consistencyScore / 100,
        },
    };
}

// ═══════════════════════════════════════════════════════════════
// Orchestrator — called from evaluate-kg.ts when --paulheim is set
// ═══════════════════════════════════════════════════════════════

export interface PaulheimOptions {
    accuracySample?: number;     // how many triples to re-verify (default 40)
    completenessSample?: number; // how many chunks to NER-sweep (default 30)
}

export async function runPaulheim(
    session: Session,
    userId: string | undefined,
    opts: PaulheimOptions = {},
): Promise<PaulheimResult[]> {
    const accSize = opts.accuracySample ?? 40;
    const compSize = opts.completenessSample ?? 30;

    console.log(`\n${C.bold}${C.magenta}═══════════════════════════════════════════════${C.reset}`);
    console.log(`${C.bold}${C.magenta}  Paulheim (2017) KG Refinement — 3 Dimensions${C.reset}`);
    console.log(`${C.bold}${C.magenta}═══════════════════════════════════════════════${C.reset}`);

    const results: PaulheimResult[] = [];
    results.push(await checkPaulheimAccuracy(session, userId, accSize));
    results.push(await checkPaulheimCompleteness(session, userId, compSize));
    results.push(await checkPaulheimConsistency(session, userId));

    // Summary
    subheader('Paulheim Summary');
    for (const r of results) {
        const colour = r.score >= 80 ? C.green : r.score >= 60 ? C.yellow : C.red;
        const icon = r.passed ? '✔' : '✘';
        console.log(`  ${colour}${icon}${C.reset} ${r.name.padEnd(30)} ${colour}${r.score.toFixed(1)}%${C.reset}  ${C.dim}${r.details}${C.reset}`);
    }

    return results;
}