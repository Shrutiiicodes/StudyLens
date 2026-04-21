# Paulheim KG Evaluation — Methodology & Report Material

## What this is

A whole-graph quality evaluation for the Study-Lens knowledge graph,
organised around the three canonical dimensions of Paulheim's (2017) KG
refinement survey — **Accuracy**, **Completeness**, and **Consistency**.
Each dimension is reported as a percentage so it drops straight into a
report table.

## How to run

After applying the integration patch (see `INTEGRATION.md`):

```bash
# Paulheim checks only — ~40 LLM calls, ~60 seconds on a typical graph
npx tsx scripts/evaluate-kg.ts --paulheim

# Or append Paulheim to the existing 7 checks
npx tsx scripts/evaluate-kg.ts --paulheim-also

# Scope to a single user's graph
npx tsx scripts/evaluate-kg.ts --paulheim --userId=<uuid>
```

## Metric definitions

### Accuracy — Verifier reacceptance rate

We sample N already-accepted triples from the Neo4j graph (default N=40)
and re-run them through the production verifier. The metric is:

> **Reacceptance rate = (re-accepted triples) / (sampled triples)**

This answers "of the triples in the graph today, how many would the
verifier still accept right now?" — it catches verifier non-determinism,
stale content, and prompt drift.

**Not** the same as absolute precision against a human gold set — for
that, run `scripts/evaluate-verifier.ts` on a hand-labeled sample (see
the verifier-eval documentation). The two numbers complement each other:
reacceptance measures *internal consistency* of the verifier over time;
human-gold precision measures *external correctness*.

**Target.** ≥ 85% is healthy. Below that, investigate: a low reacceptance
rate usually means the verifier prompt has tightened since the graph was
built, and a full re-verification pass is warranted.

### Completeness — Entity coverage ratio

We sample M source chunks (default M=30) that are attached to Concept
nodes as `sourceChunk`, extract candidate noun-phrases from each chunk
with a dependency-free heuristic, and check what fraction of candidates
appear as Concept nodes in the graph:

> **Coverage = (candidates matched to concept nodes) / (candidates found)**

The extraction heuristic identifies:
- Capitalised multi-word phrases ("Great Bath", "Indus Valley")
- Single capitalised technical terms (filtered by a short stopword list)

Matching is substring-tolerant: `"Harappan Civilization"` in the text
matches a graph node named `"Harappan"` either way round. This is
intentional — we care about whether the concept was extracted at all,
not whether it was canonicalised identically.

**Known limitations of the heuristic.**
- Misses lowercased technical terms that should be concepts (e.g. "photosynthesis" mid-sentence).
- Over-counts sentence-initial capitalised stopwords not on the stopword list.
- Doesn't distinguish proper nouns from ordinary nouns.

If you install spaCy, the metric definition doesn't change — swap the
heuristic extractor for spaCy NER in `paulheim-checks.ts`
(`extractCandidateEntities`). The coverage ratio will be tighter but the
interpretation is identical.

**Target.** ≥ 60% per Paulheim. Study-Lens graphs built from well-scoped
PDFs typically land at 65–80% with this heuristic.

### Consistency — Contradiction rate

We count edges involved in three kinds of contradiction and divide by
total Concept→Concept edges:

1. **Bidirectional same-type edges** — `(A)-[X]->(B)` AND `(B)-[X]->(A)`
   for the same type `X`. Covered by the existing cleanup script but
   re-measured here for a rate number.
2. **Cycles in DAG-relations** — `IS_A`, `PART_OF`, `PRECEDES`, `REQUIRES`,
   `EXTENSION_OF` should be DAGs by definition. Any cycle of length 2–5
   contributes its edges to the contradiction count.
3. **Mutually-exclusive type pairs** — a small hand-curated set, e.g.
   `IS_A ∩ CONTRASTS_WITH`, `PART_OF ∩ CONTAINS` (reversed),
   `CAUSES ∩ CAUSED_BY` (reversed).

> **Contradiction rate = (contradictory edges) / (total C→C edges)**
> **Consistency score = (1 − contradiction rate) × 100**

The ontology doesn't contain explicit negation predicates
(no `NOT_USED_FOR`), so this structural definition stands in for the
classic "A X B AND A ¬X B" pattern in Paulheim's framework.

**Target.** Contradiction rate ≤ 2% (consistency score ≥ 98%).

## How to write this up in your report

### Methodology paragraph

> We evaluated the knowledge graph against the three canonical
> refinement dimensions of Paulheim (2017): accuracy, completeness,
> and consistency. **Accuracy** was measured as the verifier reacceptance
> rate on a random sample of N=40 already-accepted triples — the
> fraction still passing the production verifier on a fresh pass.
> **Completeness** was measured as the entity coverage ratio on N=30
> sampled source chunks: the fraction of candidate noun phrases
> (extracted via capitalisation heuristic) that appear as Concept nodes
> in the graph. **Consistency** was measured as one minus the
> contradiction rate — the fraction of Concept→Concept edges involved in
> bidirectional same-type relations, cycles in DAG-relations
> (IS_A, PART_OF, PRECEDES, REQUIRES, EXTENSION_OF), or mutually-exclusive
> relation pairs on the same concept pair.

### Results table (fill in from script output)

| Dimension     | Metric                    | Value   | Target |
|---------------|---------------------------|---------|--------|
| Accuracy      | Verifier reacceptance     | __ %    | ≥ 85%  |
| Completeness  | Entity coverage ratio     | __ %    | ≥ 60%  |
| Consistency   | 1 − contradiction rate    | __ %    | ≥ 98%  |

### Bibliography entry

```bibtex
@article{paulheim2017knowledge,
  title   = {Knowledge graph refinement: A survey of approaches
             and evaluation methods},
  author  = {Paulheim, Heiko},
  journal = {Semantic Web},
  volume  = {8},
  number  = {3},
  pages   = {489--508},
  year    = {2017},
  publisher = {IOS Press},
  doi     = {10.3233/SW-160218}
}
```

## Cross-references with the verifier-eval harness

These are two separate evaluation layers — don't conflate them:

| Layer                 | What it measures                                | Cost        |
|-----------------------|-------------------------------------------------|-------------|
| **Verifier eval**     | Verifier agreement with human gold labels       | ~100 calls + 30 min labelling |
| **Paulheim accuracy** | Verifier self-agreement across time (drift)     | ~40 LLM calls |
| **Paulheim completeness** | Source→graph entity coverage                | 0 LLM calls |
| **Paulheim consistency** | Structural contradictions in the graph      | 0 LLM calls |

For a research-grade report, cite all four: the verifier eval establishes
the verifier's external validity; the Paulheim dimensions characterise
the resulting graph's refinement quality. This matches the layering in
Paulheim §4 (accuracy from external evaluation, refinement metrics from
internal structural analysis).