# Study System - AI-Powered Question Generation from PDFs

An intelligent system that generates multiple-choice and short-answer questions from PDF documents using knowledge graphs, semantic similarity, and LLM-based evaluation.

## Features

- **PDF Processing**: Extract and chunk PDFs with quality assessment
- **Knowledge Graph Construction**: Build concept relationships using Neo4j
- **LLM-Powered Question Generation**: Generate MCQs and short-answer questions with Groq LLM
- **Graph-Grounded Distractors**: Select contextually relevant wrong answers from knowledge graph
- **Question Evaluation**: Dual-axis distractor quality scoring (plausibility + topic relevance)
- **End-to-End Pipeline**: Automated ingestion → graph building → question generation → evaluation

## Architecture

```
PDF Upload
    ↓
Ingestion (PyMuPDF + pytesseract)
    ↓
Semantic Chunking (SentenceTransformer)
    ↓
Neo4j Graph Storage
    ↓
Concept Extraction (Groq LLM)
    ↓
Question Generation (Groq LLM)
    ↓
Evaluation & Export (JSON/CSV/PDF)
```

## Setup

### Requirements
- Python 3.9+
- Node.js (for frontend)
- Neo4j database
- Groq API key
- Supabase credentials

### Installation

1. **Clone the repository**
```bash
git clone https://github.com/yourusername/study-system.git
cd study-system
```

2. **Set up Python environment**
```bash
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

3. **Set up environment variables**
```bash
cp .env.example .env
# Edit .env with your API keys:
# - GROQ_API_KEY
# - NEO4J_URI
# - NEO4J_PASSWORD
# - SUPABASE_URL
# - SUPABASE_KEY
```

4. **Set up frontend**
```bash
cd app/frontend
npm install
npm run dev
```

## Usage

### Run Full Pipeline
```bash
# Process with rate limiting (first 10 concepts only - ~2-3 min)
python scripts/full_pipeline_test.py app/docs/your_document.pdf --limit-concepts 10

# Full processing without limit (~15-20 min)
python scripts/full_pipeline_test.py app/docs/your_document.pdf
```

### Output
Generated questions, reports, and exports are saved to:
- `exports/questions/` - JSON and CSV files
- `exports/pipeline_reports/` - Detailed PDF reports with metrics

## Project Structure

```
study-system/
├── app/
│   ├── main.py                 # FastAPI backend
│   ├── graph/                  # Knowledge graph layer
│   │   ├── concept_extractor.py
│   │   ├── question_generator.py
│   │   ├── graph_service.py
│   │   └── questions/          # Question generation
│   ├── ingestion/              # PDF processing
│   ├── models/                 # Data models
│   ├── utils/                  # Utilities
│   └── frontend/               # React + Vite
├── scripts/                    # Standalone pipeline scripts
├── tests/                      # Test suite
└── requirements.txt
```

## Key Components

### Ingestion Pipeline (`app/ingestion/`)
- PDF extraction and text normalization
- Semantic chunking with quality scoring
- OCR support via pytesseract

### Knowledge Graph (`app/graph/`)
- Neo4j-based concept and relationship storage
- Triple extraction using Groq LLM
- Neighbor finding for distractor selection

### Question Generation (`app/graph/questions/`)
- MCQ and short-answer generation
- Graph-grounded difficulty scoring
- Dual-axis distractor evaluation

## API Endpoints

- `POST /api/documents/upload` - Upload PDF
- `GET /api/documents/{doc_id}/questions` - Get generated questions
- `POST /api/documents/{doc_id}/evaluate` - Evaluate question quality

## Environment Variables

```
GROQ_API_KEY=your_groq_api_key
NEO4J_URI=bolt://localhost:7687
NEO4J_PASSWORD=your_neo4j_password
SUPABASE_URL=your_supabase_url
SUPABASE_KEY=your_supabase_key
```

## Testing

```bash
# Run all tests
pytest

# Run specific test
pytest tests/test_question_generator.py
```

## Rate Limiting

Groq free tier: 30 requests/minute. Use `--limit-concepts N` to process only the first N chunks:

```bash
--limit-concepts 5    # ~30 seconds (testing)
--limit-concepts 10   # ~2-3 minutes (recommended)
# No flag = full processing (~15-20 minutes)
```

## License

MIT License - see LICENSE file for details

## Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## Support

For issues or questions, please open a GitHub issue or contact the maintainers.
