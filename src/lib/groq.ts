import Groq from 'groq-sdk';
import { GROQ_MODEL, GROQ_TEMPERATURE, GROQ_MAX_TOKENS } from '@/config/constants';

let groqClient: Groq | null = null;

function getGroqClient(): Groq {
    if (!groqClient) {
        groqClient = new Groq({
            apiKey: process.env.GROQ_API_KEY!,
        });
    }
    return groqClient;
}

export interface LLMMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

// ============================================================================
// Rate limiting
// ============================================================================
// Groq's free tier caps you at a tokens-per-minute (TPM) budget (~6K on the
// relevant models). Nothing here previously bounded outbound calls, so any
// burst — concurrent sessions, the dual-LLM KG verification, ingestion —
// fired in parallel and tripped 429s, which then cascaded.
//
// Every Groq call in the app routes through chatCompletion(), so we gate it
// here with two mechanisms:
//   1. A concurrency semaphore  — at most GROQ_MAX_CONCURRENCY calls in flight.
//   2. A token bucket           — refills at GROQ_TPM_BUDGET tokens/minute;
//                                  a call waits until its estimated token cost
//                                  is available before going out.
// Plus centralized retry with backoff on 429/5xx (honouring Retry-After).
//
// LIMITATION: this is per-process. On Vercel serverless each instance has its
// own limiter, so it bounds bursts within an instance, not globally across
// many concurrent instances. For true global limiting you'd need a shared
// store (e.g. Upstash Redis). For this app's scale it's a real, meaningful
// guard; the honest fix for sustained production load is the paid tier.
// ============================================================================

const MAX_CONCURRENCY = Math.max(1, Number(process.env.GROQ_MAX_CONCURRENCY) || 2);
// Set this at or slightly BELOW your account's real TPM. Token estimates are
// approximate, so leaving ~10% headroom (e.g. 5500 for a 6000 cap) is wise.
const TPM_BUDGET = Math.max(1000, Number(process.env.GROQ_TPM_BUDGET) || 6000);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Rough token estimate: ~4 chars/token for the prompt, plus the reserved
 *  completion budget (max_tokens). Conservative — it reserves the worst-case
 *  completion size so we never under-budget. If throughput feels too slow,
 *  lower GROQ_MAX_TOKENS rather than inflating the chars/token divisor. */
function estimateTokens(messages: LLMMessage[], maxTokens: number): number {
    const chars = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
    return Math.ceil(chars / 4) + maxTokens;
}

/** Continuously-refilling token bucket for the TPM budget. */
class TokenBucket {
    private tokens: number;
    private lastRefill: number;
    private readonly refillPerSec: number;

    constructor(private readonly capacity: number) {
        this.tokens = capacity;
        this.lastRefill = Date.now();
        this.refillPerSec = capacity / 60;
    }

    private refill(): void {
        const now = Date.now();
        const elapsed = (now - this.lastRefill) / 1000;
        if (elapsed > 0) {
            this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
            this.lastRefill = now;
        }
    }

    async acquire(cost: number): Promise<void> {
        // A single request can never need more than the whole budget, else it
        // would wait forever. Clamp so an over-large estimate still drains and
        // proceeds rather than deadlocking.
        const need = Math.min(cost, this.capacity);
        // JS is single-threaded: refill + compare + deduct happen with no await
        // between them, so two waiters can't both deduct the same tokens.
        for (; ;) {
            this.refill();
            if (this.tokens >= need) {
                this.tokens -= need;
                return;
            }
            const deficit = need - this.tokens;
            const waitMs = Math.ceil((deficit / this.refillPerSec) * 1000);
            await sleep(Math.min(waitMs, 2000)); // re-check at least every 2s
        }
    }
}

/** Concurrency semaphore with slot hand-off (no busy-waiting). */
class Semaphore {
    private active = 0;
    private readonly queue: Array<() => void> = [];

    constructor(private readonly max: number) { }

    async acquire(): Promise<void> {
        if (this.active < this.max) {
            this.active++;
            return;
        }
        // Wait for a slot to be handed to us; the releaser keeps `active`
        // unchanged on hand-off, so we don't increment again here.
        await new Promise<void>((resolve) => this.queue.push(resolve));
    }

    release(): void {
        const next = this.queue.shift();
        if (next) {
            next();             // hand the slot directly to the next waiter
        } else {
            this.active--;      // no one waiting — free the slot
        }
    }
}

const tokenBucket = new TokenBucket(TPM_BUDGET);
const concurrency = new Semaphore(MAX_CONCURRENCY);

async function withRateLimit<T>(estTokens: number, fn: () => Promise<T>): Promise<T> {
    await concurrency.acquire();
    try {
        await tokenBucket.acquire(estTokens);
        return await fn();
    } finally {
        concurrency.release();
    }
}

interface GroqLikeError {
    status?: number;
    headers?: Record<string, string | undefined>;
    message?: string;
}

function isRetryable(err: GroqLikeError): boolean {
    const status = err?.status;
    if (status === 429) return true;
    if (typeof status === 'number' && status >= 500 && status < 600) return true;
    const msg = (err?.message ?? '').toLowerCase();
    return msg.includes('timeout') || msg.includes('network') || msg.includes('econn');
}

/** Run the SDK call with backoff on 429/5xx/transient errors. Honours the
 *  Retry-After header when Groq supplies one. */
async function createWithRetry(
    client: Groq,
    params: Parameters<Groq['chat']['completions']['create']>[0],
    maxRetries = 4
): Promise<string> {
    let lastErr: unknown = new Error('Unknown Groq error');

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await client.chat.completions.create(params);
            // Non-streaming params -> response is a ChatCompletion.
            return (response as any).choices?.[0]?.message?.content || '';
        } catch (err) {
            lastErr = err;
            const e = err as GroqLikeError;
            if (attempt === maxRetries || !isRetryable(e)) break;

            const retryAfterSec = Number(e?.headers?.['retry-after']);
            const backoff = Number.isFinite(retryAfterSec) && retryAfterSec > 0
                ? retryAfterSec * 1000
                : Math.min(8000, Math.pow(2, attempt) * 500) + Math.random() * 300;

            console.warn(
                `[Groq] ${e?.status ?? 'transient'} on attempt ${attempt}/${maxRetries}; retrying in ${Math.round(backoff)}ms`
            );
            await sleep(backoff);
        }
    }

    throw lastErr;
}

/**
 * Send a chat completion request to Groq LLM.
 *
 * All callers go through here, so the request is rate-limited against the TPM
 * budget and concurrency cap, and retried on 429/5xx. The public signature and
 * return value are unchanged.
 */
export async function chatCompletion(
    messages: LLMMessage[],
    options?: {
        temperature?: number;
        maxTokens?: number;
        model?: string;
        jsonMode?: boolean;
    }
): Promise<string> {
    const client = getGroqClient();
    const maxTokens = options?.maxTokens ?? GROQ_MAX_TOKENS;

    const params = {
        model: options?.model || GROQ_MODEL,
        messages,
        temperature: options?.temperature ?? GROQ_TEMPERATURE,
        max_tokens: maxTokens,
        response_format: options?.jsonMode ? { type: 'json_object' as const } : undefined,
    };

    const est = estimateTokens(messages, maxTokens);
    return withRateLimit(est, () => createWithRetry(client, params));
}

/**
 * Parse JSON from LLM response, with fallback error handling.
 */
export function parseLLMJson<T>(response: string): T {
    try {
        // Try to extract JSON from markdown code blocks if present
        const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
        const jsonStr = jsonMatch ? jsonMatch[1].trim() : response.trim();
        return JSON.parse(jsonStr);
    } catch (error) {
        console.error('Failed to parse LLM JSON response:', error);
        console.error('Raw response:', response);
        throw new Error('Failed to parse LLM response as JSON');
    }
}

/**
 * Validate content with LLM - check if it's academic/educational.
 */
export async function validateAcademicContent(text: string): Promise<{
    isAcademic: boolean;
    reasoning: string;
    conceptDensity: number;
}> {
    // Sample from the middle of the document to skip cover pages, copyright
    // notices, table of contents, etc. — all of which look non-academic to
    // a validator even when the document itself is a real textbook.
    const sample = buildValidationSample(text);

    const response = await chatCompletion(
        [
            {
                role: 'system',
                content: `You are an educational content validator. Analyze the given text and determine:
1. Is this academic/educational content suitable for CBSE Grade 4-10 students?
2. What is the concept density (0-1 scale, where 1 = very concept-rich)?
Respond in JSON format: { "isAcademic": boolean, "reasoning": string, "conceptDensity": number }`,
            },
            {
                role: 'user',
                content: sample,
            },
        ],
        { jsonMode: true }
    );

    return parseLLMJson(response);
}

/**
 * Build a representative sample from the document for academic-content
 * validation. Skips the first ~15% (cover, TOC, copyright) and samples
 * from the middle, where actual educational content lives.
 */
function buildValidationSample(text: string): string {
    if (text.length <= 2000) return text;

    // Skip first 15% to bypass front matter
    const startOffset = Math.floor(text.length * 0.15);
    const midStart = Math.min(startOffset, text.length - 2000);
    return text.substring(midStart, midStart + 2000);
}