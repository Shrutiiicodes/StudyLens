import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase';
import { buildKnowledgeGraph } from '@/lib/kg-builder';
import { validateAcademicContent } from '@/lib/groq';
import { MIN_WORD_COUNT, MAX_FILE_SIZE_MB } from '@/config/constants';

export const maxDuration = 60;
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
    try {
        const formData = await request.formData();
        const file = formData.get('file') as File | null;
        const userId = formData.get('userId') as string | null;

        if (!file || !userId) {
            return NextResponse.json(
                { error: 'Missing file or userId' },
                { status: 400 }
            );
        }

        // Validate file type
        const allowedTypes = [
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ];
        if (!allowedTypes.includes(file.type)) {
            return NextResponse.json(
                { error: 'Only PDF and DOCX files are supported' },
                { status: 400 }
            );
        }

        // Validate file size
        if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
            return NextResponse.json(
                { error: `File size exceeds ${MAX_FILE_SIZE_MB}MB limit` },
                { status: 400 }
            );
        }

        const supabase = getServiceSupabase();

        // Parse text from file
        const buffer = Buffer.from(await file.arrayBuffer());
        let text = '';

        if (file.type === 'application/pdf') {
            const { PDFParse } = await import('pdf-parse');
            const parser = new PDFParse({ data: buffer });
            const pdfData = await parser.getText();
            text = pdfData.text;
            await parser.destroy();
        } else {
            const mammoth = await import('mammoth');
            const result = await mammoth.extractRawText({ buffer });
            text = result.value;
        }

        // Validate word count
        const wordCount = text.split(/\s+/).filter(Boolean).length;
        const warnings: string[] = [];

        if (wordCount < MIN_WORD_COUNT) {
            warnings.push(`Document has only ${wordCount} words (minimum ${MIN_WORD_COUNT} recommended)`);
        }

        // Validate academic content
        const validation = await validateAcademicContent(text);

        if (!validation.isAcademic) {
            return NextResponse.json(
                {
                    error: 'Content does not appear to be academic/educational',
                    reasoning: validation.reasoning,
                },
                { status: 400 }
            );
        }

        if (validation.conceptDensity < 0.2) {
            warnings.push('Low concept density detected. Results may be limited.');
        }

        // Upload to Supabase Storage
        const filePath = `uploads/${userId}/${Date.now()}_${file.name}`;
        const { error: uploadError } = await supabase.storage
            .from('documents')
            .upload(filePath, buffer, {
                contentType: file.type,
                upsert: false,
            });

        if (uploadError) {
            console.error('Storage upload error:', uploadError);
            return NextResponse.json(
                { error: 'Failed to store document' },
                { status: 500 }
            );
        }

        // Create concept record
        const { data: concept, error: conceptError } = await supabase
            .from('concepts')
            .insert({
                user_id: userId,
                title: file.name.replace(/\.[^/.]+$/, ''),
                source_document: filePath,
            })
            .select()
            .single();

        if (conceptError || !concept) {
            return NextResponse.json(
                { error: 'Failed to create concept record' },
                { status: 500 }
            );
        }

        // ── Phase A: Study-Lens KG build (primary, always runs) ──────────────
        let kgResult = { nodes: [] as unknown[], relations: [] as unknown[] };
        try {
            const kg = await buildKnowledgeGraph(userId, concept.id, text);
            kgResult = kg;
        } catch (kgError) {
            console.error('KG building error:', kgError);
            warnings.push('Knowledge graph generation encountered an issue.');
        }

        // ── Phase B: IPD backend ingestion (supplementary, non-fatal) ────────
        let pipelineData: {
            doc_id?: string;
            page_count?: number;
            chunk_count?: number;
            triple_count?: number;
            question_count?: number;
            ocr_applied?: boolean;
        } = {};

        try {
            const { ingestDocument } = await import('@/lib/backend-client');
            const ingestResult = await ingestDocument(filePath, userId, concept.id);

            pipelineData = {
                doc_id: ingestResult.doc_id,
                page_count: ingestResult.page_count,
                chunk_count: ingestResult.chunk_count,
                triple_count: ingestResult.triple_count,
                question_count: ingestResult.question_count,
                ocr_applied: ingestResult.ocr_applied,
            };

            // Record the pipeline run in Supabase
            await supabase.from('pipeline_runs').insert({
                user_id: userId,
                concept_id: concept.id,
                doc_id: ingestResult.doc_id,
                storage_path: filePath,
                page_count: ingestResult.page_count,
                chunk_count: ingestResult.chunk_count,
                triple_count: ingestResult.triple_count,
                question_count: ingestResult.question_count,
                quality_score: ingestResult.quality_score ?? 0,
                ocr_applied: ingestResult.ocr_applied ?? false,
                status: 'completed',
                completed_at: new Date().toISOString(),
            });

            console.log(
                `[Upload] Backend ingestion complete — doc_id: ${ingestResult.doc_id}, ` +
                `chunks: ${ingestResult.chunk_count}, questions: ${ingestResult.question_count}`
            );
        } catch (backendError) {
            console.warn('[Upload] Backend ingestion failed (non-fatal):', backendError);
            warnings.push('OCR pipeline unavailable — using standard text extraction.');

            // Record failed pipeline run
            await supabase.from('pipeline_runs').insert({
                user_id: userId,
                concept_id: concept.id,
                doc_id: '',
                storage_path: filePath,
                status: 'failed',
                error_message: backendError instanceof Error ? backendError.message : String(backendError),
            });
        }

        return NextResponse.json({
            success: true,
            concept,
            knowledgeGraph: {
                nodeCount: kgResult.nodes.length,
                relationCount: kgResult.relations.length,
            },
            pipeline: pipelineData.doc_id ? {
                docId: pipelineData.doc_id,
                pageCount: pipelineData.page_count,
                chunkCount: pipelineData.chunk_count,
                tripleCount: pipelineData.triple_count,
                questionCount: pipelineData.question_count,
                ocrApplied: pipelineData.ocr_applied,
            } : null,
            warnings,
            validation: {
                wordCount,
                conceptDensity: validation.conceptDensity,
                isAcademic: validation.isAcademic,
            },
        });
    } catch (error) {
        console.error('Upload error:', error);
        return NextResponse.json(
            { error: 'Internal server error during upload' },
            { status: 500 }
        );
    }
}