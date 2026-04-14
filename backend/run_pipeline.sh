#!/bin/bash
# Quick script to run the full pipeline and generate reports

cd /Users/tanishaprabhu/Desktop/projects/study-system

# Activate virtual environment
source .venv/bin/activate

# Run the pipeline
echo "Starting Study System Pipeline..."
echo "=================================="
python scripts/full_pipeline_test.py harappa.pdf

echo ""
echo "Pipeline complete!"
echo "Check exports/pipeline_reports/ for reports:"
echo "  - JSON report: pipeline_report_*.json"
echo "  - Markdown report: pipeline_report_*.md"
echo "  - PDF report: pipeline_report_*.pdf"
echo ""
echo "Questions exported to:"
echo "  - exports/questions/doc_*_questions.json"
echo "  - exports/questions/doc_*_questions.csv"
