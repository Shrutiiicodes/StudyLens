# 🔬 Study Lens — AI-Powered Foundational Concept Mastery Platform

> CBSE Grade 4–10 | Adaptive Learning | Knowledge Graphs | Personalization Engine

Study Lens is a production-grade ed-tech web application that helps students master foundational concepts through AI-powered adaptive learning. Upload your study material, and the system automatically builds a knowledge graph, generates multi-type questions at adaptive difficulty levels, and tracks mastery using a mathematical personalization engine.

## ✨ Features

- **📄 Smart Document Upload** — PDF/DOCX upload with AI validation and knowledge extraction
- **🧠 Knowledge Graph** — Neo4j-powered concept mapping with definitions, examples, formulas, and misconceptions
- **🎯 5 Question Types** — Recall, Conceptual, Application, Reasoning, Analytical
- **📊 3 Difficulty Levels** — Easy, Medium, Hard with probabilistic adaptive sampling
- **🔍 4 Assessment Modes** — Diagnostic, Practice, Mastery, Spaced Reinforcement
- **⚡ Mathematical Personalization** — Exact formulas for scoring, mastery updates, and forgetting model
- **📈 Student Ability Index (SAI)** — Holistic score combining mastery, trend, accuracy, and calibration
- **⏰ Forgetting Model** — Exponential decay with optimal review time calculation
- **📋 Rich Dashboard** — Radar charts, timelines, misconception alerts, progress tracking

## 🛠 Tech Stack

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

## 📁 Project Structure

```
src/
├── app/
│   ├── api/
│   │   ├── upload/route.ts       # Document upload & KG building
│   │   ├── diagnostic/route.ts   # Diagnostic test generation/evaluation
│   │   ├── assessment/route.ts   # Practice/Mastery/Spaced assessment
│   │   └── mastery/route.ts      # Mastery dashboard data
│   ├── dashboard/
│   │   ├── layout.tsx            # Dashboard sidebar layout
│   │   ├── page.tsx              # Main dashboard
│   │   ├── upload/page.tsx       # Upload page
│   │   ├── concepts/page.tsx     # All concepts
│   │   ├── concept/[id]/page.tsx # Concept detail
│   │   ├── test/[id]/page.tsx    # Test/Assessment page
│   │   ├── learn/[id]/page.tsx   # Learn mode
│   │   └── history/page.tsx      # Test history
│   ├── login/page.tsx            # Auth page
│   ├── layout.tsx                # Root layout
│   ├── page.tsx                  # Landing page
│   └── globals.css               # Design system
├── components/
│   ├── UploadZone.tsx            # Drag & drop upload
│   ├── ProgressCard.tsx          # Concept progress card
│   ├── QuestionCard.tsx          # MCQ with confidence slider
│   ├── MasteryGraph.tsx          # Radar & timeline charts
│   └── ConceptMap.tsx            # Canvas-based KG visualization
├── lib/
│   ├── supabase.ts               # Supabase client
│   ├── neo4j.ts                  # Neo4j driver
│   ├── groq.ts                   # Groq LLM client
│   ├── embeddings.ts             # Text chunking & embeddings
│   ├── kg-builder.ts             # Knowledge Graph builder
│   ├── question-generator.ts     # Question generation from KG
│   ├── personalization-engine.ts # Full math formulas
│   ├── forgetting-model.ts       # Exponential decay model
│   ├── evaluation-engine.ts      # Answer evaluation & mastery update
│   └── utils.ts                  # Utilities
├── config/
│   ├── constants.ts              # All configuration constants
│   └── difficulty-engine.ts      # Difficulty distribution
└── types/
    ├── student.ts                # Student/Profile types
    ├── concept.ts                # Concept/KG types
    ├── question.ts               # Question types
    └── mastery.ts                # Mastery/Assessment types
```

## 🚀 Getting Started

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

### 2. Setup Supabase

1. Go to [supabase.com](https://supabase.com) and create a new project
2. In the SQL Editor, run the following to create tables:

```sql
-- Profiles table
CREATE TABLE profiles (
  id UUID REFERENCES auth.users PRIMARY KEY,
  full_name TEXT,
  grade INTEGER,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW())
);

-- Concepts table
CREATE TABLE concepts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users NOT NULL,
  title TEXT NOT NULL,
  source_document TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW())
);

-- Mastery table
CREATE TABLE mastery (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users NOT NULL,
  concept_id UUID REFERENCES concepts NOT NULL,
  mastery_score FLOAT DEFAULT 0,
  last_updated TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW()),
  UNIQUE(user_id, concept_id)
);

-- Attempts table
CREATE TABLE attempts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users NOT NULL,
  concept_id UUID REFERENCES concepts NOT NULL,
  question_id TEXT NOT NULL,
  correct BOOLEAN NOT NULL,
  difficulty INTEGER NOT NULL,
  cognitive_level INTEGER NOT NULL,
  time_taken INTEGER NOT NULL,
  confidence FLOAT DEFAULT 0.5,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc', NOW())
);

-- Create storage bucket for documents
INSERT INTO storage.buckets (id, name, public) VALUES ('documents', 'documents', false);

-- RLS Policies (enable RLS on all tables first)
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE concepts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mastery ENABLE ROW LEVEL SECURITY;
ALTER TABLE attempts ENABLE ROW LEVEL SECURITY;

-- Profiles: users can read/update their own
CREATE POLICY "Users can view own profile" ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON profiles FOR UPDATE USING (auth.uid() = id);

-- Concepts: users can CRUD their own
CREATE POLICY "Users can view own concepts" ON concepts FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create concepts" ON concepts FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Mastery: users can view/update their own
CREATE POLICY "Users can view own mastery" ON mastery FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can update own mastery" ON mastery FOR ALL USING (auth.uid() = user_id);

-- Attempts: users can view/create their own
CREATE POLICY "Users can view own attempts" ON attempts FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create attempts" ON attempts FOR INSERT WITH CHECK (auth.uid() = user_id);
```

3. Copy your project URL and keys from Settings > API

### 3. Setup Neo4j AuraDB

1. Go to [neo4j.com/aura](https://neo4j.com/aura/) and create a free instance
2. Copy the connection URI, username, and password
3. No schema setup needed — the app creates nodes dynamically

### 4. Get API Keys

- **Groq**: Sign up at [console.groq.com](https://console.groq.com) and create an API key
- **Embeddings** (optional): Use an OpenAI API key for text-embedding-3-small, or leave blank for fallback

### 5. Configure Environment

Copy `.env.example` to `.env.local`:

```bash
cp .env.example .env.local
```

Fill in all values:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
NEO4J_URI=neo4j+s://xxxx.databases.neo4j.io
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your-password
GROQ_API_KEY=gsk_xxxxx
EMBEDDING_API_KEY=sk-xxxxx
```

### 6. Run Locally

```bash
npm run dev
```

Visit [http://localhost:3000](http://localhost:3000)

### 7. Deploy to Vercel

```bash
npx vercel
```

Or connect your GitHub repo to Vercel and set environment variables in the dashboard.

## 🧮 Personalization Engine

### Core Formulas

| Component | Formula |
|-----------|---------|
| Accuracy | `Acc = A ∈ {0, 1}` |
| Cognitive Depth | `CD = CL_q / 2.5` |
| Difficulty Weight | `DW = D_q / 3` |
| Speed Efficiency | `SE = min(1, T_exp / T)` |
| Confidence Calibration | `CC = 1 - \|A - C_f\|` |
| Misconception Penalty | `MP = 1 - (misconception_freq / total_attempts)` |

### Scoring by Mode

| Mode | Formula |
|------|---------|
| Diagnostic | `DS = 0.5·Acc + 0.3·CD + 0.2·CC` |
| Practice | `PS = 0.4·Acc̄ + 0.2·CD̄ + 0.15·SĒ + 0.15·CC̄ + 0.1·MP` |
| Mastery | `MS = 0.35·Acc̄ + 0.30·CD̄ + 0.15·MP + 0.10·SĒ + 0.10·CC̄` |
| Spaced | `RS = 0.5·Acc + 0.3·TW + 0.2·SE` |

### Mastery Update

```
M_new = (1 - λ)·M_old + λ·(100 × Score)
```

| Mode | λ |
|------|---|
| Practice | 0.2 |
| Mastery | 0.35 |
| Spaced | 0.5 |

### Forgetting Model

```
M_decayed = M × e^(-γ·Δt)
γ = 0.05
```

### Student Ability Index

```
SAI = 0.5·M + 0.2·Trend + 0.2·GlobalAcc + 0.1·Calibration
```

## 📝 License

MIT

## 🤝 Contributing

Contributions are welcome! Please open an issue first to discuss changes.
