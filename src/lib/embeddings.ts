import { chatCompletion, parseLLMJson } from './groq';

/**
 * Simple embedding function using Groq / OpenAI-compatible API.
 * Falls back to a basic hash-based pseudo-embedding if no embedding API key.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
    const apiKey = process.env.EMBEDDING_API_KEY;

    if (!apiKey) {
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

function pseudoEmbedding(text: string): number[] {
    const dimensions = 384;
    const embedding = new Array(dimensions).fill(0);

    for (let i = 0; i < text.length; i++) {
        const charCode = text.charCodeAt(i);
        const idx = i % dimensions;
        embedding[idx] = (embedding[idx] + charCode * (i + 1)) % 1000 / 1000;
    }

    const magnitude = Math.sqrt(embedding.reduce((sum: number, val: number) => sum + val * val, 0));
    return magnitude > 0 ? embedding.map((v: number) => v / magnitude) : embedding;
}

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

// ─── Chunk confidence flags ───────────────────────────────────────────────────

export type ConfidenceFlag =
    | 'BOUNDARY_CUT'       // chunk ended at a hard char boundary, not a sentence
    | 'CAPTION_ONLY'       // looks like a figure/table caption with no body
    | 'TABLE_REMNANT'      // high numeric density — probably a table row
    | 'MATH_DENSE'         // equation-heavy chunk
    | 'TOO_SHORT'          // below minimum useful length
    | 'HIGH_NOISE_CHARS';  // high ratio of non-ASCII / garbled characters

export interface TextChunk {
    text: string;
    chunkIndex: number;
    startChar: number;
    endChar: number;
    confidenceScore: number;   // 0.0–1.0
    confidenceFlags: ConfidenceFlag[];
}

// ─── Regex patterns ───────────────────────────────────────────────────────────

// Natural split points, in priority order
const SPLIT_PATTERNS = [
    /\n{2,}/,                        // blank line / paragraph break
    /(?<=[.!?])\s+/,                  // sentence ending
    /\n/,                             // single newline
];

// Caption-only detector — likely a figure/table label with no body text
const CAPTION_ONLY_RE = /^\s*(fig(?:ure)?\.?\s*\d+|table\s*\d+|diagram\s*\d*|chart\s*\d*|illustration\s*\d*)\b[^.]{0,120}$/i;

// Table row remnant — 3+ numbers in a row, or pipe-separated cells
const TABLE_ROW_RE = /(\d+\.?\d*\s+){3,}|(\|\s*\w+\s*){2,}/;

// Math-dense content
const MATH_DENSE_RE = /[∫∑∏√∞±×÷≈≠≤≥∂∇∆αβγδεζηθλμπρσφψω]|\\(?:frac|sqrt|sum|int|lim|alpha|beta|gamma|delta)\b|\^[\d\w{]/;

// Non-ASCII / garbage characters
const NOISE_RE = /[^\x09\x0A\x0D\x20-\x7E\u00A0-\u024F]/g;

// ─── Confidence scorer ────────────────────────────────────────────────────────

function scoreChunkConfidence(
    text: string,
    boundaryWasCut: boolean
): { score: number; flags: ConfidenceFlag[] } {
    const flags: ConfidenceFlag[] = [];
    let score = 1.0;

    // Penalise hard boundary cuts
    if (boundaryWasCut) {
        flags.push('BOUNDARY_CUT');
        score -= 0.1;
    }

    // Too short
    if (text.length < 100) {
        flags.push('TOO_SHORT');
        score -= 0.3;
    }

    // Caption only
    if (CAPTION_ONLY_RE.test(text)) {
        flags.push('CAPTION_ONLY');
        score -= 0.4;
    }

    // Table remnant
    if (TABLE_ROW_RE.test(text)) {
        flags.push('TABLE_REMNANT');
        score -= 0.25;
    }

    // Math-dense
    if (MATH_DENSE_RE.test(text)) {
        flags.push('MATH_DENSE');
        score -= 0.15;
    }

    // High noise ratio
    const noiseChars = (text.match(NOISE_RE) || []).length;
    const noiseRatio = noiseChars / Math.max(text.length, 1);
    if (noiseRatio > 0.05) {
        flags.push('HIGH_NOISE_CHARS');
        score -= Math.min(0.3, noiseRatio * 4);
    }

    return { score: Math.max(0, Math.round(score * 100) / 100), flags };
}

// ─── Natural boundary finder ──────────────────────────────────────────────────

/**
 * Split text at the best natural boundary (paragraph > sentence > newline).
 * Returns index of split point or -1 if none found in the window.
 */
function findNaturalBoundary(
    text: string,
    searchFrom: number,
    searchTo: number,
    minFrom: number
): number {
    const window = text.slice(searchFrom, searchTo);

    // Try each pattern in priority order
    for (const pattern of SPLIT_PATTERNS) {
        const match = [...window.matchAll(new RegExp(pattern, 'g'))].pop();
        if (match && match.index !== undefined) {
            const absoluteIdx = searchFrom + match.index + match[0].length;
            if (absoluteIdx > minFrom) {
                return absoluteIdx;
            }
        }
    }

    return -1; // no natural boundary found
}

// ─── Main chunker ─────────────────────────────────────────────────────────────

/**
 * Smart chunker — ported from the Python backend with the following improvements
 * over the original simple character-split version:
 *
 *  1. Semantic boundary detection — prefers paragraph > sentence > newline breaks
 *  2. Confidence scoring — each chunk gets a 0–1 quality score + flags
 *  3. Overlap safety — never moves start pointer backwards (fixes RangeError)
 *  4. Noise filtering — chunks with score < minConfidence are dropped
 *
 * Parameters match the Python Chunker defaults:
 *   chunkSize    = 1000 chars  (≈ 250 tokens)
 *   chunkOverlap = 150  chars
 *   minChunkSize = 50   chars
 */
export function chunkText(
    text: string,
    {
        chunkSize = 1000,
        chunkOverlap = 150,
        minChunkSize = 50,
        minConfidence = 0.3,
    }: {
        chunkSize?: number;
        chunkOverlap?: number;
        minChunkSize?: number;
        minConfidence?: number;
    } = {}
): string[] {
    return chunkTextDetailed(text, { chunkSize, chunkOverlap, minChunkSize, minConfidence })
        .map((c) => c.text);
}

/**
 * Same as chunkText but returns full TextChunk objects including confidence
 * scores and flags. Used by the consensus evaluator script.
 */
export function chunkTextDetailed(
    text: string,
    {
        chunkSize = 1000,
        chunkOverlap = 150,
        minChunkSize = 50,
        minConfidence = 0.3,
    }: {
        chunkSize?: number;
        chunkOverlap?: number;
        minChunkSize?: number;
        minConfidence?: number;
    } = {}
): TextChunk[] {
    if (!text || text.trim().length === 0) return [];

    if (chunkOverlap >= chunkSize) {
        throw new Error('chunkOverlap must be less than chunkSize');
    }

    const chunks: TextChunk[] = [];
    let start = 0;
    let chunkIndex = 0;

    while (start < text.length) {
        const rawEnd = Math.min(start + chunkSize, text.length);
        let end = rawEnd;
        let boundaryWasCut = false;

        // Try to find a natural split point in the last 40% of the window
        if (end < text.length) {
            const searchFrom = start + Math.floor(chunkSize * 0.6);
            const boundary = findNaturalBoundary(text, searchFrom, rawEnd, start + minChunkSize);

            if (boundary > 0) {
                end = boundary;
            } else {
                // No natural boundary found — hard cut
                boundaryWasCut = true;
            }
        }

        const chunkRaw = text.slice(start, end).trim();

        if (chunkRaw.length >= minChunkSize) {
            const { score, flags } = scoreChunkConfidence(chunkRaw, boundaryWasCut);

            if (score >= minConfidence) {
                chunks.push({
                    text: chunkRaw,
                    chunkIndex,
                    startChar: start,
                    endChar: end,
                    confidenceScore: score,
                    confidenceFlags: flags,
                });
                chunkIndex++;
            }
        }

        // ── CRITICAL: always advance forward ──────────────────────────────
        // If overlap would push start back to or before current position,
        // just move past this chunk entirely. This prevents the RangeError
        // that occurred in the old implementation.
        const nextStart = end - chunkOverlap;
        start = nextStart > start ? nextStart : end;
    }

    return chunks;
}