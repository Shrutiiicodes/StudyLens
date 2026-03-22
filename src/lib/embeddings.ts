import { chatCompletion, parseLLMJson } from './groq';

/**
 * Simple embedding function using Groq / OpenAI-compatible API.
 * Falls back to a basic hash-based pseudo-embedding if no embedding API key.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
    const apiKey = process.env.EMBEDDING_API_KEY;

    if (!apiKey) {
        // Fallback: use LLM to create a semantic fingerprint
        return pseudoEmbedding(text);
    }

    try {
        const response = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'text-embedding-3-small',
                input: text,
            }),
        });

        const data = await response.json();
        return data.data[0].embedding;
    } catch (error) {
        console.error('Embedding generation failed, using fallback:', error);
        return pseudoEmbedding(text);
    }
}

/**
 * Generate pseudo-embeddings using a hash function when no embedding API is available.
 * This is a simplified fallback - not suitable for production similarity search.
 */
function pseudoEmbedding(text: string): number[] {
    const dimensions = 384;
    const embedding = new Array(dimensions).fill(0);

    for (let i = 0; i < text.length; i++) {
        const charCode = text.charCodeAt(i);
        const idx = i % dimensions;
        embedding[idx] = (embedding[idx] + charCode * (i + 1)) % 1000 / 1000;
    }

    // Normalize
    const magnitude = Math.sqrt(embedding.reduce((sum: number, val: number) => sum + val * val, 0));
    return magnitude > 0 ? embedding.map((v: number) => v / magnitude) : embedding;
}

/**
 * Calculate cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) throw new Error('Vectors must have the same length');

    let dotProduct = 0;
    let magnitudeA = 0;
    let magnitudeB = 0;

    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        magnitudeA += a[i] * a[i];
        magnitudeB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB);
    return magnitude > 0 ? dotProduct / magnitude : 0;
}

/**
 * Chunk text into segments of approximately the specified token count.
 * Rough approximation: 1 token ≈ 4 characters.
 */
export function chunkText(
    text: string,
    minTokens: number = 500,
    maxTokens: number = 800,
    overlapTokens: number = 50
): string[] {
    const charPerToken = 4;
    const minChars = minTokens * charPerToken;
    const maxChars = maxTokens * charPerToken;
    const overlapChars = overlapTokens * charPerToken;

    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
        let end = Math.min(start + maxChars, text.length);

        // Try to break at sentence boundary
        if (end < text.length) {
            const lastPeriod = text.lastIndexOf('.', end);
            const lastNewline = text.lastIndexOf('\n', end);
            const breakPoint = Math.max(lastPeriod, lastNewline);

            if (breakPoint > start + minChars) {
                end = breakPoint + 1;
            }
        }

        chunks.push(text.slice(start, end).trim());
        start = end - overlapChars;
    }

    return chunks.filter((chunk) => chunk.length > 0);
}
