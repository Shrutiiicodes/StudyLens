# Verifier Evaluation — Methodology & Report Material

This folder contains a two-stage evaluation harness for the KG triple
verifier, plus the bibliography material your report should cite.

## What this evaluates

The verifier in `src/lib/kg-builder.ts` (and its Python sibling in
`backend/graph/triple_verifier.py`) decides whether each LLM-extracted
triple is supported by its source passage. It outputs a verdict
(`a` directly stated, `b` implied, `c` unsupported) plus a confidence
score, and the production threshold accepts `(a, conf ≥ 0.65)` or
`(b, conf ≥ 0.80)`.

The evaluation answers two questions:

1. **Does the verifier agree with a human judge?** — binary precision /
   recall / F1 against hand-labeled triples.
2. **Are the production thresholds well-tuned?** — a sweep over the
   verdict-`a` confidence cutoff to show how the metrics shift.

## Two-stage workflow

### Stage 1 — Build the gold set

```bash
npx tsx scripts/extract-gold-triples.ts --input=path/to/sample.pdf --target=120
```

This runs the production extract + verify pipeline on the input and
writes `eval-output/verifier-gold.csv` with one row per candidate triple.
Each row contains the triple, its source chunk, the verifier's verdict
and confidence, and three blank columns for the human label.

The script targets ~120 candidates so you can skip ambiguous ones and
still land at ~100 labeled. Hand-labeling 100 triples takes about
30 minutes.

### Stage 2 — Label by hand

Open the CSV in any spreadsheet tool. For each row, read `chunk_text`
and fill in:

- **`human_label_binary`**: `y` if the triple is directly or implicitly
  supported by the chunk; `n` otherwise. This is the headline metric.
- **`human_label_verdict`**: `a` (directly stated), `b` (implied), or
  `c` (unsupported). Optional but recommended — it gives you a 3-way
  confusion matrix that shows where the verifier is over- or under-
  confident.
- **`human_notes`**: free text for ambiguous cases. Helpful when you
  re-visit the gold set later.

### Stage 3 — Compute metrics

```bash
npx tsx scripts/evaluate-verifier.ts
```

Prints the confusion matrix, precision / recall / F1, the 3-way verdict
matrix, and a threshold sweep. Also writes `eval-output/verifier-eval.json`
for programmatic access.

## How to write this up in your report

### Methodology section

> We evaluated the LLM-as-a-judge verifier (Zheng et al., 2023) on a
> hand-labeled gold set of N triples sampled from a representative
> CBSE Grade-X PDF. Each triple was independently labeled by [name]
> as `supported` (directly stated or strongly implied by the source
> passage) or `unsupported`. We measured precision, recall, and F1
> against the verifier's accept/reject decision at the production
> thresholds (verdict `a` with confidence ≥ 0.65, OR verdict `b` with
> confidence ≥ 0.80). We also performed a threshold sweep on the
> verdict-`a` cutoff to characterise the precision–recall trade-off.
>
> The verifier uses a different LLM than the extractor — `qwen3-32b`
> for extraction, `llama-3.1-8b-instant` for verification — implementing
> the cross-examination pattern of Cohen et al. (2023) in which a
> separate model judges the output of the generator to detect factual
> errors.

### Results section

Drop in a table from the script output:

```
              actual=y  actual=n
pred=accept       TP        FP
pred=reject       FN        TN

Precision: __%   Recall: __%   F1: __%   Accuracy: __%
```

If the threshold sweep shows F1 peaking somewhere other than 0.65, name
that in the discussion: "F1 peaks at threshold X, but we keep the
production cutoff at 0.65 to favour recall — losing supported triples
costs more than admitting marginal ones because each lost triple is a
KG edge that would otherwise have grounded a question."

### Bibliography entries

```bibtex
@inproceedings{zheng2023judging,
  title     = {Judging {LLM}-as-a-Judge with {MT}-Bench and Chatbot Arena},
  author    = {Zheng, Lianmin and Chiang, Wei-Lin and Sheng, Ying and
               Zhuang, Siyuan and Wu, Zhanghao and Zhuang, Yonghao and
               Lin, Zi and Li, Zhuohan and Li, Dacheng and Xing, Eric P.
               and Zhang, Hao and Gonzalez, Joseph E. and Stoica, Ion},
  booktitle = {Advances in Neural Information Processing Systems
               ({NeurIPS}) Datasets and Benchmarks Track},
  year      = {2023}
}

@inproceedings{cohen2023lmvslm,
  title     = {{LM} vs {LM}: Detecting Factual Errors via Cross
               Examination},
  author    = {Cohen, Roi and Hamri, May and Geva, Mor and Globerson,
               Amir},
  booktitle = {Proceedings of the 2023 Conference on Empirical Methods
               in Natural Language Processing ({EMNLP})},
  year      = {2023}
}
```

## Notes on reproducibility

- **Extractor temperature is 0.2**, not 0, so two runs on the same input
  will produce slightly different triples. This is intentional — it
  matches production. If you need exact reproducibility, lower the
  temperature in `extract-gold-triples.ts` (and note the change in your
  methodology).
- **The script inlines the prompt strings** rather than importing them
  from `src/config/prompts.ts` so the gold set is a frozen snapshot of
  what was evaluated. If you change a production prompt, regenerate the
  gold set.
- **Threshold sweep keeps verdict-`b` fixed at 0.80** so you're tuning
  one knob at a time. If you want to sweep both, modify
  `printThresholdSweep` in `evaluate-verifier.ts`.

## Output paths

```
eval-output/
├── verifier-gold.csv       ← Stage 1 output, you label this
├── verifier-gold.json      ← same data, machine-readable
└── verifier-eval.json      ← Stage 3 output, full metrics
```