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

/**
 * Send a chat completion request to Groq LLM.
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

    const response = await client.chat.completions.create({
        model: options?.model || GROQ_MODEL,
        messages,
        temperature: options?.temperature ?? GROQ_TEMPERATURE,
        max_tokens: options?.maxTokens ?? GROQ_MAX_TOKENS,
        response_format: options?.jsonMode ? { type: 'json_object' } : undefined,
    });

    return response.choices[0]?.message?.content || '';
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
                content: text.substring(0, 2000), // First 2000 chars for validation
            },
        ],
        { jsonMode: true }
    );

    return parseLLMJson(response);
}
