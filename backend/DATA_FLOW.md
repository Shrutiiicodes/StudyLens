# Pipeline Data Flow & Outputs

## Complete Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         USER UPLOADS PDF                                    │
│                      (via Supabase Storage)                                 │
└────────────────────────────┬────────────────────────────────────────────────┘
                             │
        ┌────────────────────▼────────────────────┐
        │   STAGE 1: INGESTION PIPELINE           │
        │   ✓ Validate upload                     │
        │   ✓ Download from Supabase              │
        │   ✓ Extract text (OCR)                  │
        │   ✓ Chunk (1000 chars, 150 overlap)    │
        │   ✓ Quality validation                  │
        └────────────────────┬────────────────────┘
                             │
                    OUTPUT 1: Chunks
                    ├─ doc_id
                    ├─ page_count: 11
                    ├─ chunk_count: 62
                    ├─ char_total: 41,222
                    └─ quality_score: 0.84
                             │
        ┌────────────────────▼────────────────────┐
        │   STAGE 2: GRAPH WRITE (NEO4J)          │
        │   ✓ Create (:Document) node             │
        │   ✓ Create (:Chunk) nodes               │
        │   ✓ Link PART_OF relationships         │
        │   ✓ Link sequential NEXT_CHUNK         │
        └────────────────────┬────────────────────┘
                             │
                    OUTPUT 2: Neo4j Graph
                    ├─ Nodes created
                    ├─ Relationships: PART_OF
                    └─ Sequential linking
                             │
        ┌────────────────────▼────────────────────┐
        │   STAGE 3: CONCEPT EXTRACTION           │
        │   For each chunk:                        │
        │   ✓ Send to Groq LLM                    │
        │   ✓ Extract (S, R, O) triples           │
        │   ✓ Validate & normalize               │
        │   ✓ Create (:Concept) nodes            │
        │   ✓ Create typed edges                 │
        │   ✓ Link (:Chunk)-[:MENTIONS]-(...)    │
        └────────────────────┬────────────────────┘
                             │
                    OUTPUT 3: Knowledge Graph
                    ├─ (:Concept) nodes: 120+
                    ├─ Triples: 150+
                    ├─ Relation types: 12
                    └─ Sample:
                       Great Bath -> LOCATED_IN -> Mohenjodaro
                       Great Bath -> USED_FOR -> Ritual Bathing
                             │
        ┌────────────────────▼────────────────────┐
        │   STAGE 4: QUESTION GENERATION          │
        │   For each triple:                       │
        │   ✓ LLM: triple → (question, answer)   │
        │   ✓ Graph: find neighbors (1-3 hops)   │
        │   ✓ Filter distractors semantically    │
        │   ✓ If ≥3 distractors → MCQ            │
        │   ✓ Else → short-answer                │
        │   ✓ Set difficulty by hop distance     │
        └────────────────────┬────────────────────┘
                             │
                    OUTPUT 4: Questions
                    ├─ Total: 140+
                    ├─ MCQ: 98 (70%)
                    ├─ Short: 44 (30%)
                    ├─ Difficulty dist:
                    │  ├─ Easy: 45
                    │  ├─ Medium: 67
                    │  └─ Hard: 28
                    └─ Sample:
                       {
                         question: "What was the Great Bath used for?",
                         type: "mcq",
                         options: [correct, dist1, dist2, dist3],
                         distractor_distances: {dist1: 1, dist2: 2, dist3: 3}
                       }
                             │
        ┌────────────────────▼────────────────────┐
        │   STAGE 5: QUESTION EVALUATION          │
        │   For each question:                     │
        │   ✓ Score answerability                │
        │   ✓ Score relevance                    │
        │   ✓ Score quality                      │
        │   ✓ Score distractor quality           │
        │   ✓ Compute overall accuracy           │
        │   ✓ Categorize: Excellent/Good/Med/Poor│
        └────────────────────┬────────────────────┘
                             │
                    OUTPUT 5: Evaluation Report
                    ├─ avg_answerability: 0.82
                    ├─ avg_relevance: 0.74
                    ├─ avg_quality: 0.86
                    ├─ avg_distractor_quality: 0.71
                    ├─ overall_accuracy: 0.78
                    └─ Distribution:
                       ├─ Excellent (≥0.8): 78 ✓
                       ├─ Good (0.6-0.8): 48 ✓
                       ├─ Moderate (0.4-0.6): 14 ⚠
                       └─ Poor (<0.4): 2 ✗
                             │
        ┌────────────────────▼────────────────────┐
        │   STAGE 6: EXPORT & REPORTING           │
        │   ✓ Export questions to JSON            │
        │   ✓ Export questions to CSV             │
        │   ✓ Generate JSON report                │
        │   ✓ Generate Markdown report            │
        │   ✓ Generate PDF report                 │
        └────────────────────┬────────────────────┘
                             │
         ┌───────────────────┬───────────────────┬─────────────────┐
         │                   │                   │                 │
    OUTPUT 6a:          OUTPUT 6b:          OUTPUT 6c:          OUTPUT 6d:
    JSON Questions      CSV Questions       JSON Report         Markdown Report
                                                                  & PDF Report
    doc_..._            doc_..._            pipeline_report_    pipeline_report_
    questions.json      questions.csv       *.json              *.md/.pdf


All outputs in: exports/
  ├── questions/
  │   ├── doc_..._questions.json
  │   └── doc_..._questions.csv
  └── pipeline_reports/
      ├── pipeline_report_*.json
      ├── pipeline_report_*.md
      └── pipeline_report_*.pdf
```

## Data Structures at Each Stage

### Stage 1: IngestionResult
```
{
  doc_id: "doc_775dd3268c3f0955"
  storage_path: "harappa.pdf"
  page_count: 11
  chunk_count: 62
  chunks: [
    {
      chunk_id: "doc_775dd3268c3f0955:chunk_0"
      text: "...",
      char_count: 1000,
      start_page: 1,
      end_page: 2
    },
    ...
  ]
  quality_report: {...}
}
```

### Stage 3: Concept Triples
```
[
  {
    subject: "Great Bath"
    relation: "LOCATED_IN"
    object: "Mohenjodaro"
    chunk_id: "doc_...:chunk_0"
  },
  {
    subject: "Great Bath"
    relation: "USED_FOR"
    object: "Ritual Bathing"
    chunk_id: "doc_...:chunk_0"
  },
  ...
]
```

### Stage 4: Generated Question
```
{
  question_id: "q_abc123def456"
  doc_id: "doc_775dd3268c3f0955"
  question: "What was the primary purpose of the Great Bath in Mohenjodaro?"
  correct: "A large public structure used for ritual bathing"
  q_type: "mcq"
  difficulty: "medium"
  concept: "Great Bath"
  relation: "USED_FOR"
  source_chunk: "doc_...:chunk_0"
  options: [
    "A large public structure used for ritual bathing",
    "A military fortress",
    "A storage facility",
    "A residential palace"
  ]
  distractor_distances: {
    "A military fortress": 2,
    "A storage facility": 3,
    "A residential palace": 1
  }
}
```

### Stage 5: Question Score
```
{
  question: "What was the primary purpose...",
  answerability: 0.92,
  concept_relevance: 0.88,
  context_relevance: 0.79,
  relevance: 0.84,
  grammar: 1.0,
  clarity: 0.95,
  quality: 0.98,
  distractor_quality: 0.76,
  overall: 0.85
}
```

## Pipeline Metrics Summary

### Input vs Output Ratio
```
Input:  1 PDF (harappa.pdf, 11 pages, 1MB)
   ↓
Output: 
  - 62 chunks
  - 120+ concepts
  - 150+ triples
  - 140+ questions
  - 6 comprehensive reports
```

### Quality Distribution (Expected)
```
Overall Accuracy: 0.78

Excellent ████████████████████░░░░░░░░░░░░ 78 (55%)
Good      ███████████████░░░░░░░░░░░░░░░░░ 48 (34%)
Moderate  ██░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 14 (10%)
Poor      █░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  2 (1%)
```

### Question Type Distribution
```
MCQ           ████████████████████░░░░░░░░░░ 98 (70%)
Short Answer  █████████░░░░░░░░░░░░░░░░░░░░ 44 (30%)
```

### Question Difficulty Distribution
```
Easy   ████████████░░░░░░░░░░░░░░░░░░░░░░░ 45 (32%)
Medium ██████████████░░░░░░░░░░░░░░░░░░░░░ 67 (48%)
Hard   ██████░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 28 (20%)
```

## Evaluation Metrics Explanation

### Answerability (avg: 0.82)
- **What:** Can this question be answered from the source chunk?
- **Method:** LLM scoring or semantic similarity
- **Range:** 0.0-1.0
- **Good:** ≥ 0.7

### Relevance (avg: 0.74)
- **What:** Is the question relevant to the concept and source?
- **Components:** 
  - Concept relevance (0.88)
  - Context relevance (0.79)
- **Range:** 0.0-1.0
- **Good:** ≥ 0.7

### Quality (avg: 0.86)
- **What:** Grammar, clarity, structure
- **Components:**
  - Grammar (0.95)
  - Clarity (0.95)
- **Range:** 0.0-1.0
- **Good:** ≥ 0.8

### Distractor Quality (avg: 0.71)
- **What:** Quality of wrong answer options
- **Axes:**
  - Plausibility: 0.30-0.70 vs correct (0.65)
  - Topic relevance: ≥0.12-0.20 vs concept (0.77)
- **Range:** 0.0-1.0
- **Good:** ≥ 0.6

### Overall Accuracy (avg: 0.78)
- **Formula:** 
  - 35% Answerability
  - 30% Relevance  
  - 35% Quality
  - +15% Distractor Quality (if MCQ)
- **Range:** 0.0-1.0
- **Good:** ≥ 0.75

## File Locations

```
/Users/tanishaprabhu/Desktop/projects/study-system/

├── scripts/
│   └── full_pipeline_test.py         ← Main pipeline script
│
├── app/
│   ├── graph/
│   │   ├── concept_repository.py     ← Updated
│   │   ├── questions/
│   │   │   ├── question_evaluator.py ← Updated  
│   │   │   └── question_generator.py ← Updated
│
├── exports/
│   ├── pipeline_reports/             ← Reports generated here
│   │   ├── pipeline_report_*.json
│   │   ├── pipeline_report_*.md
│   │   └── pipeline_report_*.pdf
│   └── questions/
│       ├── doc_*_questions.json
│       └── doc_*_questions.csv
│
├── QUICK_START.md                    ← Start here
├── PIPELINE_TESTING.md               ← Detailed guide
├── SETUP_COMPLETE.md                 ← Full overview
└── run_pipeline.sh                   ← Quick run script
```

## Time Breakdown

```
┌─ STAGE 1: Ingestion ────────────── 2-3 min
│  ├─ Download: 10 sec
│  ├─ Extract (OCR): 1-2 min
│  └─ Chunk & validate: 30 sec
│
├─ STAGE 2: Graph Write ─────────── 5 sec
│
├─ STAGE 3: Concept Extraction ──── 2-3 min
│  └─ 62 chunks × 2-3 sec/chunk
│
├─ STAGE 4: Question Generation ─── 3-5 min
│  └─ 150+ triples × 1-2 sec/triple
│
├─ STAGE 5: Evaluation ──────────── 1-2 min
│  └─ 140+ questions × 0.5-1 sec/question
│
├─ STAGE 6: Export & Reports ────── 10-20 sec
│
└─ TOTAL ────────────────────────── 15-20 min
```

## Cost Breakdown

```
┌─ Groq LLM calls ──────────────────── $0.05
├─ Supabase (PDF download) ─────────── $0.01
├─ Neo4j (queries) ──────────────────── Free (dev tier)
└─ TOTAL ────────────────────────────── ~$0.10 per document
```
