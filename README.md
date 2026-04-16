# StudyLens — AI-Powered Foundational Concept Mastery Platform

> CBSE Grade 4–10 | Adaptive Learning | Knowledge Graphs | Personalization Engine

Study Lens is a production-grade ed-tech web application that helps students master foundational concepts through AI-powered adaptive learning. Upload your study material, and the system automatically builds a knowledge graph, generates multi-type questions at adaptive difficulty levels, and tracks mastery using a mathematically principled personalization engine.

## Features

- **Smart Document Upload** — PDF/DOCX upload with AI validation and knowledge extraction
- **Knowledge Graph** — Neo4j-powered concept mapping with definitions, examples, formulas, and misconceptions
- **5 Question Types** — Recall, Conceptual, Application, Reasoning, Analytical
- **3 Difficulty Levels** — Easy, Medium, Hard with probabilistic adaptive sampling (Rasch-calibrated)
- **3 Assessment Modes** — Diagnostic (Easy 5), Practice, Mastery
- **Silent Spaced Review** — Questions from older concepts are silently injected into practice/mastery sessions using FSRS retrievability (Ye, 2022)
- **BKT Mastery Tracking** — Bayesian Knowledge Tracing (Corbett & Anderson, 1994) replaces EMA for principled posterior beliefs
- **Student Ability Index (SAI)** — Holistic score combining mastery, trend, accuracy, and calibration
- **Standard ITS Metrics** — NLG (Hake, 1998), Brier Score, ECE (Guo et al., 2017), Log-Loss reported per session
- **IRT Difficulty Calibration** — Rasch model (1960) calibrates question difficulty from response data
- **Rich Dashboard** — Radar charts, timelines, misconception alerts, progress tracking
- **Research Export** — CSV export of all attempt-level data in ASSISTments-compatible format

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14 (App Router), TypeScript, TailwindCSS |
| Charts | Recharts |
| Auth | Supabase Auth |
| Database | Supabase (PostgreSQL) |
| Knowledge Graph | Neo4j AuraDB |
| LLM | Groq API (LLaMA 3.3 70B) |
| Embeddings | OpenAI-compatible API |
| Deployment | Vercel |

## Assessment Flow

```
Upload Document
     ↓
Diagnostic (Easy 5) ──pass 80%──→ Practice ──pass 80%──→ Mastery ──pass 80%──→ ✓ Complete
     ↓ fail                           ↓ fail                  ↓ fail
  Learn It                          Learn It               Learn It
```

Spaced review questions from previously completed concepts are silently injected into Practice and Mastery sessions — students see them blended into the test without a separate mode.

## Project Structure

```
src/
├── app/
│   ├── api/
│   │   ├── upload/route.ts        # Document upload & KG building
│   │   ├── diagnostic/route.ts    # Assessment generation/evaluation
│   │   ├── assessment/route.ts    # Practice/Mastery assessment
│   │   ├── mastery/route.ts       # Mastery dashboard data
│   │   ├── irt/route.ts           # IRT difficulty params per question
│   │   ├── irt/fit/route.ts       # BKT EM parameter fitting
│   │   ├── export/route.ts        # Research CSV export
│   │   └── progress/route.ts      # Stage progression
│   ├── dashboard/
│   │   ├── layout.tsx             # Dashboard sidebar layout
│   │   ├── page.tsx               # Main dashboard
│   │   ├── upload/page.tsx        # Upload page
│   │   ├── concepts/page.tsx      # All concepts with stage progress
│   │   ├── concept/[id]/page.tsx  # Concept detail
│   │   ├── test/[id]/page.tsx     # Test/Assessment page
│   │   ├── learn/[id]/page.tsx    # Learn mode
│   │   └── history/page.tsx       # Test history (real sessions)
│   ├── login/page.tsx             # Auth page
│   ├── layout.tsx                 # Root layout
│   └── page.tsx                   # Landing page
├── lib/
│   ├── bkt.ts                     # Bayesian Knowledge Tracing
│   ├── irt.ts                     # Rasch IRT model
│   ├── eval-metrics.ts            # NLG, Brier, ECE, Log-Loss + legacy metrics
│   ├── evaluation-engine.ts       # Answer evaluation & mastery update
│   ├── forgetting-model.ts        # Exponential decay + FSRS
│   ├── personalization-engine.ts  # Scoring, SAI, difficulty distribution
│   ├── question-generator.ts      # Question generation from KG
│   ├── kg-builder.ts              # Knowledge Graph builder
│   └── supabase.ts / neo4j.ts     # DB clients
├── config/
│   └── constants.ts               # PASS_THRESHOLD=80, all config
└── types/
    ├── student.ts                  # AssessmentMode type
    ├── mastery.ts                  # QuestionResult, MasteryUpdate
    └── question.ts                 # Question types
```

## Getting Started

### Prerequisites

- Node.js 18+
- npm
- Supabase account
- Neo4j AuraDB account
- Groq API key

### 1. Clone & Install

```bash
git clone <your-repo-url>
cd study-lens
npm install
```

### 2. Run Supabase Migrations

Run these SQL files in order in your Supabase SQL Editor:

```
migrations/001_standard_its_metrics.sql   # NLG, Brier, ECE, Log-Loss columns
migrations/002_irt_difficulty_calibration.sql  # question_irt table + IRT columns
migrations/003_bkt_fitting_spaced_flag.sql     # concept_bkt_params + is_spaced_review
```

### 3. Environment Variables

```bash
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
NEO4J_URI=
NEO4J_USER=
NEO4J_PASSWORD=
GROQ_API_KEY=
NEXT_PUBLIC_BACKEND_URL=http://localhost:8000
```

### 4. Run

```bash
npm run dev
```

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/diagnostic` | POST | Generate or evaluate assessment sessions |
| `/api/metrics` | GET | Student-level ITS metrics (NLG, Brier, ECE, etc.) |
| `/api/irt` | GET | IRT difficulty params per question/concept |
| `/api/irt/fit` | POST | EM fitting of BKT params per concept |
| `/api/export` | GET | Research CSV export (ASSISTments-compatible) |
| `/api/progress` | GET | Stage progression per concept |

## Key Citations

- Corbett & Anderson (1994) — Bayesian Knowledge Tracing
- Hake (1998) — Normalized Learning Gain
- Rasch (1960) — Item Response Theory
- Baker et al. (2008) — BKT parameter calibration for MCQ
- Bloom (1984) — 80% mastery learning threshold
- Guo et al. (2017) — Expected Calibration Error
- Ye (2022) — FSRS spaced repetition scheduler