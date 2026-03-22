import { NextRequest, NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase';
import { chatCompletion, parseLLMJson } from '@/lib/groq';
import { PROMPTS } from '@/config/prompts';

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const conceptId = searchParams.get('conceptId');
        const grade = searchParams.get('grade') || '10';

        if (!conceptId) {
            return NextResponse.json({ error: 'Missing conceptId' }, { status: 400 });
        }

        const supabase = getServiceSupabase();

        // 1. Fetch concept and document path
        const { data: concept, error: conceptError } = await supabase
            .from('concepts')
            .select('*')
            .eq('id', conceptId)
            .single();

        if (conceptError || !concept) {
            return NextResponse.json({ error: 'Concept not found' }, { status: 404 });
        }

        // 2. Fetch the text content from Supabase Storage
        const { data: fileData, error: downloadError } = await supabase.storage
            .from('documents')
            .download(concept.source_document);

        if (downloadError || !fileData) {
            console.error('Download error:', downloadError);
            return NextResponse.json({ error: 'Failed to download document content' }, { status: 500 });
        }

        const text = await fileData.text();
        const truncatedText = text.substring(0, 15000); // Send first 15k chars to LLM

        // 3. Generate Learn Content using Groq
        const response = await chatCompletion(
            [
                { role: 'system', content: PROMPTS.LEARN_GUIDE.system(grade) },
                { role: 'user', content: PROMPTS.LEARN_GUIDE.user(concept.title, truncatedText) },
            ],
            { jsonMode: true }
        );

        const learnContent = parseLLMJson(response);

        return NextResponse.json({
            success: true,
            content: learnContent
        });

    } catch (error) {
        console.error('Learn API error:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}
