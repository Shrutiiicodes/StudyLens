import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase';
import { buildKnowledgeGraph } from '@/lib/kg-builder';
import { validateAcademicContent } from '@/lib/groq';
import { MIN_WORD_COUNT, MAX_FILE_SIZE_MB } from '@/config/constants';

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
            try {
                const { PDFParse } = await import('pdf-parse');
                const parser = new PDFParse({ data: buffer });
                const result = await parser.getText();
                text = result.text;

                if (!text || text.trim().length < 100) {
                    return NextResponse.json(
                        {
                            error: 'Could not extract text from this PDF. If it is a scanned document, please use a text-based PDF instead.',
                        },
                        { status: 422 }
                    );
                }
            } catch (pdfError) {
                console.error('PDF parsing error:', pdfError);
                return NextResponse.json(
                    {
                        error: 'Failed to parse PDF file.',
                        details: (pdfError as Error).message,
                    },
                    { status: 422 }
                );
            }
        } else {
            // DOCX parsing
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
                { 
                    error: 'Failed to store document', 
                    details: uploadError.message,
                    code: (uploadError as any).statusCode || (uploadError as any).code
                },
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

        // Build Knowledge Graph (async but we wait for it)
        try {
            const kg = await buildKnowledgeGraph(userId, concept.id, text);

            return NextResponse.json({
                success: true,
                concept,
                knowledgeGraph: {
                    nodeCount: kg.nodes.length,
                    relationCount: kg.relations.length,
                },
                warnings,
                validation: {
                    wordCount,
                    conceptDensity: validation.conceptDensity,
                    isAcademic: validation.isAcademic,
                },
            });
        } catch (kgError) {
            console.error('KG building error:', kgError);
            return NextResponse.json({
                success: true,
                concept,
                warnings: [...warnings, 'Knowledge graph generation is still processing'],
                validation: {
                    wordCount,
                    conceptDensity: validation.conceptDensity,
                },
            });
        }
    } catch (error) {
        console.error('Upload error:', error);
        return NextResponse.json(
            { error: 'Internal server error during upload' },
            { status: 500 }
        );
    }
}
