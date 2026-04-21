# Study-Lens

> An AI-powered concept-mastery platform for CBSE Grade 4-10 students. Upload study material, and the system extracts a knowledge graph, generates adaptive assessments, tracks mastery with Bayesian Knowledge Tracing, and surfaces misconceptions as actionable feedback.

Built as a prototype for the CBSE curriculum. Most of what's novel here is how the pieces fit together — a knowledge graph drives distractor selection, a Rasch model calibrates difficulty from response data, and a silent spaced-repetition layer injects review questions into new sessions without the student noticing.

## What it does

- **Upload a PDF or DOCX.** The system extracts concepts, definitions, examples, and relationships via LLM and writes them to a Neo4j knowledge graph.
- **Take a diagnostic.** Five questions, mixed difficulty, gives you a mastery score.
- **Practice, then prove mastery.** Adaptive difficulty sampling; the graph supplies distractors; BKT updates your posterior.
- **Get targeted feedback.** When you get a question wrong, the system walks the shortest path in the graph between your wrong answer and the right answer, and an LLM explains the gap.
- **Review automatically.** Spaced-review questions from older concepts are silently blended into practice and mastery sessions based on FSRS retrievability.
- **Export your data.** A full ASSISTments-compatible CSV of every attempt is available.

## Assessment flow

```
Upload Document
     ↓
Diagnostic (Easy 5) ──pass 80%──→ Practice ──pass 80%──→ Mastery ──pass 80%──→ ✓ Complete
     ↓ fail                            ↓ fail                   ↓ fail
  Learn It                           Learn It                Learn It
```

Spaced-review questions from older concepts are injected into Practice and Mastery sessions — the student sees them blended into the test, not in a separate mode.

## Tech stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16 (App Router), React 19, TypeScript |
| Styling | Tailwind CSS 4 |
| Charts | Recharts |
| Auth | Supabase Auth |
| Database | Supabase (PostgreSQL) |
| Knowledge Graph | Neo4j AuraDB |
| LLM | Groq API (qwen3-32b for extraction, llama-3.1-8b-instant for verification) |
| Embeddings | OpenAI `text-embedding-3-small` when `EMBEDDING_API_KEY` is set; falls back to a hash-based pseudo-embedding otherwise |
| Deployment | Vercel |

## Project structure

```
study-lens/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── upload/route.ts          # Document upload, Supabase storage, KG build
│   │   │   ├── concepts/route.ts        # List concepts (with decayed mastery)
│   │   │   ├── concepts/[id]/route.ts   # Delete a concept + all derived data
│   │   │   ├── concepts/tag/route.ts    # Subject-domain backfill for KG nodes
│   │   │   ├── diagnostic/route.ts      # Question generation + session evaluation
│   │   │   ├── progress/route.ts        # Per-concept stage and mastery
│   │   │   ├── mastery/route.ts         # Dashboard mastery overview
│   │   │   ├── metrics/route.ts         # Student-level ITS metrics
│   │   │   ├── user/stats/route.ts      # SAI, totals, quick stats
│   │   │   ├── history/route.ts         # Session list + weak-topic aggregation
│   │   │   ├── learn/route.ts           # Learn-mode content (KG or LLM fallback)
│   │   │   ├── graph/route.ts           # KG data for concept-detail page
│   │   │   ├── irt/route.ts             # Per-question Rasch difficulty
│   │   │   ├── irt/fit/route.ts         # BKT EM fit per concept
│   │   │   └── export/route.ts          # ASSISTments-compatible CSV
│   │   ├── dashboard/
│   │   │   ├── layout.tsx               # Sidebar, session keep-alive
│   │   │   ├── page.tsx                 # Main dashboard
│   │   │   ├── upload/page.tsx          # Upload page
│   │   │   ├── concepts/page.tsx        # Concept list with stages
│   │   │   ├── concept/[id]/page.tsx    # Concept detail + history tab
│   │   │   ├── test/[id]/page.tsx       # Test runner (all modes)
│   │   │   ├── learn/[id]/page.tsx      # Learn mode
│   │   │   └── history/page.tsx         # Session history + weak topics
│   │   ├── login/page.tsx               # Auth
│   │   ├── layout.tsx                   # Root layout
│   │   └── page.tsx                     # Landing
│   ├── lib/
│   │   ├── bkt.ts                       # Bayesian Knowledge Tracing
│   │   ├── irt.ts                       # Rasch IRT model
│   │   ├── eval-metrics.ts              # NLG, Brier, ECE, Log-Loss + legacy metrics
│   │   ├── evaluation-engine.ts         # Session evaluation & mastery update
│   │   ├── forgetting-model.ts          # Exponential decay + FSRS
│   │   ├── personalization-engine.ts    # Difficulty sampling, SAI
│   │   ├── question-generator.ts        # Question generation (calls KG + LLM)
│   │   ├── distractor-engine.ts         # Graph-hop distractors, misconception analysis
│   │   ├── kg-builder.ts                # Knowledge Graph builder
│   │   ├── embeddings.ts                # Smart chunker + embedding API
│   │   ├── groq.ts                      # LLM client
│   │   ├── neo4j.ts                     # Neo4j driver
│   │   ├── supabase.ts                  # Supabase service/browser clients
│   │   └── supabase-server.ts           # Supabase SSR helpers
│   ├── config/
│   │   ├── constants.ts                 # PASS_THRESHOLD, stage keys, LLM config
│   │   └── prompts.ts                   # All LLM prompts
│   └── types/
│       ├── student.ts                   # AssessmentMode, Profile
│       ├── mastery.ts                   # QuestionResult, MasteryUpdate
│       ├── question.ts                  # Question, QuestionType
│       ├── concept.ts                   # Concept, ConceptRecord, ProgressData
│       └── session.ts                   # SessionRecord, WeakTopic, SessionBreakdown
├── supabase/
│   └── schema.sql                       # Canonical DB schema (idempotent)
├── backend/                             # Optional Python backend (OCR + enrichment)
├── public/
├── next.config.ts
├── package.json
└── README.md
```

The `backend/` folder contains a secondary Python FastAPI service for OCR-heavy PDF ingestion. It's optional — the Next.js app works fully without it, falling back to the built-in pdf-parse extractor.

## Getting started

### Prerequisites

- Node.js 18 or higher
- Supabase account (free tier works)
- Neo4j AuraDB account (free tier works)
- Groq API key

### 1. Clone and install

```bash
git clone <your-repo-url>
cd study-lens
npm install
```

### 2. Set up the database

Open your Supabase project's SQL Editor and run the contents of `supabase/schema.sql`. The script is idempotent, safe to re-run.

Then, in the Supabase Dashboard → **Storage**, create a bucket named `documents` with public access **disabled**.

### 3. Environment variables

Create a `.env.local` file in the project root:

```bash
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=       # Supabase publishable key (or legacy anon)
SUPABASE_SERVICE_ROLE_KEY=           # Supabase secret key (or legacy service_role)
NEO4J_URI=
NEO4J_USER=
NEO4J_PASSWORD=
GROQ_API_KEY=

# Optional
EMBEDDING_API_KEY=                   # OpenAI key for real embeddings; hash fallback used if absent
NEXT_PUBLIC_BACKEND_URL=             # Python backend URL if deployed; optional
```

Supabase's modern key system uses publishable + secret keys instead of the legacy anon/service_role. Either works — the variable names are just identifiers.

### 4. Run

```bash
npm run dev
```

Open `http://localhost:3000`. Sign in, upload a PDF, and work through the flow.

## API reference

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/upload` | POST | Upload a document; builds the knowledge graph |
| `/api/concepts` | GET | List user's concepts with decayed mastery |
| `/api/concepts/[id]` | DELETE | Delete a concept and all derived data |
| `/api/diagnostic` | POST | Generate questions (`action: 'generate'`) or evaluate a session (`action: 'evaluate'`). Used by all assessment modes. |
| `/api/progress` | GET | Per-concept stage + mastery |
| `/api/mastery` | GET | Dashboard mastery summary with FSRS-based review urgency |
| `/api/metrics` | GET | Student-level ITS metrics (NLG, Brier, ECE, Log-Loss) |
| `/api/history` | GET | Session list with per-session breakdown + weak topics |
| `/api/learn` | GET | Learn-mode content |
| `/api/graph` | GET | Knowledge graph for concept-detail page |
| `/api/irt` | GET | Rasch difficulty for a question |
| `/api/irt/fit` | POST | Trigger EM fitting of BKT params per concept |
| `/api/export` | GET | Research CSV export (ASSISTments-compatible) |
| `/api/user/stats` | GET | Compact stats for dashboard widgets |

All data routes accept `userId` as a query parameter and use the service-role Supabase client on the server.

## Architecture notes

### Why a knowledge graph

LLMs can invent plausible-sounding distractors, but plausibility isn't pedagogical. A graph-hop distractor is always a real concept from the same document, at a known graph distance from the correct answer. That distance also gives us a free difficulty signal:

- All distractors 1 hop away → hard
- Mix of 1 and 2 hops → medium
- Mostly 3+ hops → easy

Difficulty comes from graph topology, not an LLM saying "this is hard."

### Why BKT instead of a moving average

A moving average of recent scores conflates forgetting with lack of knowledge. BKT (Corbett & Anderson, 1994) separates the two: there's a latent "knows it" state, a transition probability, and separate slip/guess parameters per concept. It answers "how likely is this student to get the next question right?" as a proper posterior, not as a moving average of the past.

### Why silent spaced review

Students don't think about spaced repetition; they think about "today's test." So spaced questions are injected silently — when you take a mastery session for Concept A, one or two questions from Concept B (which you completed weeks ago and whose FSRS retrievability has dropped below threshold) are blended in. The injection is tracked via the `is_spaced_review` flag on attempt rows, but spaced questions don't factor into the session's score — they feed into Concept B's BKT posterior instead.

### Three-stage progression

Every concept has three stages: `diagnostic` → `practice` → `mastery`. Each requires 80% to unlock the next, following Bloom's (1984) 2-sigma threshold. "Complete" is the terminal state — not a fourth stage.

## Known limitations (as of prototype ship)

- **Groq free tier rate limits.** Knowledge graph extraction on large documents (>2000 words) can hit the 6000 TPM limit on qwen3-32b. The verifier has been tuned down to llama-3.1-8b-instant, but the primary extraction still uses the larger model. Either use smaller documents, wait for the 41-second rate window, or upgrade to Groq Dev Tier.
- **Open RLS policies.** All tables have RLS enabled but policies are `USING (true)` — any authenticated user can technically read any data. This is acceptable for a prototype with non-sensitive test data, not for production. See `supabase/schema.sql` for the TODO block with the ownership-based pattern.
- **Misconceptions table.** Schema exists; `storeAttempt` writes inline to the `attempts` table instead of a separate `misconceptions` row. Future work.
- **Demo user.** The layout uses a hardcoded demo UUID to short-circuit auth for testing. Remove before a real deployment.

## Citations

The system is built on published results:

- Bloom, B.S. (1984). *The 2 sigma problem.* Educational Researcher, 13(6).
- Corbett & Anderson (1994). *Knowledge Tracing.* User Modeling and User-Adapted Interaction.
- Hake (1998). *Interactive-engagement vs traditional methods.* American Journal of Physics.
- Rasch, G. (1960). *Probabilistic Models for Some Intelligence and Attainment Tests.*
- Baker et al. (2008). *More accurate student modeling through contextual estimation of slip and guess probabilities.* ITS Conference.
- Guo et al. (2017). *On Calibration of Modern Neural Networks.* ICML.
- Ye, J. (2022). *A stochastic shortest path algorithm for optimizing spaced repetition scheduling.* KDD.
- Feng, Heffernan & Koedinger (2009). *Addressing the assessment challenge with an Online System that Tutors as it Assesses.* User Modeling & User-Adapted Interaction (ASSISTments dataset format).

## License

Private prototype. Not yet licensed for reuse.