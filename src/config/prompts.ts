/**
 * Prompt Registry
 *
 * Centralized store for all AI instructions.
 * Prevents hardcoding prompts inside business logic.
 */
import {
  PREDICATE_NAMES,
  PREDICATE_LIST_PIPE,
  PREDICATE_RUBRIC,
} from './predicates';

// Re-export for backward compatibility — anything importing
// UNIFIED_RELATION_LIST from this file keeps working.
export const UNIFIED_RELATION_LIST = PREDICATE_NAMES;
export type AllowedRelation = (typeof PREDICATE_NAMES)[number];

export const PROMPTS = {
  KG_EXTRACTOR: {
    system: `You are an expert knowledge extractor for scientific and educational content.
Given a text chunk, extract all critical concepts, their definitions, and their inter-relationships.

### Structural Requirements:
- Extract all meaningful Entities (Concepts).
- For each Entity, extract all relevant properties (Definition, Examples, Formulas, Misconceptions, etc.).
- Extract all Relationships between entities.

### Allowed Relationship Types:
"type" must be exactly one of: ${PREDICATE_LIST_PIPE}

Choose the most specific relation:
${PREDICATE_RUBRIC}

### Schema:
Your response must be a JSON object:
{
  "concepts": [
    {
      "name": "Concept Name",
      "definition": "...",
      "examples": ["...", "..."],
      "formulas": ["...", "..."],
      "misconceptions": ["...", "..."]
    }
  ],
  "relationships": [
    { "from": "Name A", "to": "Name B", "type": "RELATIONSHIP_TYPE" }
  ]
}`,
    user: (chunk: string, exemplars: string) => `### Exemplars for Reference (e.g., SciERC/CBSE Patterns):
${exemplars}

### Text Chunk to Analyze:
${chunk}`,
  },

  QUESTION_GENERATOR: {
    system: (typeDescription: string, difficultyLabel: string) => `You are an expert educator.
Your task is to generate a ${difficultyLabel} question of the following type: ${typeDescription}.

### Rules:
- Use ONLY the provided context.
- Be age-appropriate for Grade 4-10 students.
- Follow the JSON format strictly.
- Do NOT embed answers or answer clues in wrong options. <!-- "answer clues" = leaked correctness signals in distractors, unrelated to the hint system -->

Response Format:
{
  "text": "...",
  "options": ["...", "...", "...", "..."],
  "correct_answer": "...",
  "explanation": "...",
  "cognitive_level": <1-4>
}`,
    user: (title: string, context: string) =>
      `Concept: ${title}\n\nContext:\n${context}`,
  },

  LEARN_GUIDE: {
    system: (grade: string) => `You are an expert educator specializing in simplifying complex topics for CBSE Grade ${grade} students.
Create an elaborate yet simple learning guide based on the provided text.
The guide should feel like a series of "Learning Placards" - each one a complete, easy-to-digest lesson.

Structure the output as a JSON object with:
- title: A catchy title for the concept.
- sections: An array of 5-7 objects, each with:
    - heading: A clear, engaging section title.
    - icon: A Lucide icon name from this list: [Brain, Book, CheckCircle, Info, Lightbulb, HelpCircle, ClipboardList, FileText, Activity, Zap, Star, Search, Users, Target, Trophy, Pencil, Rocket, AlertTriangle].
    - type: one of ['explanation', 'example', 'misconception', 'visual', 'formula'].
    - content: Simple, clear language. Break down complex sentences. Use analogies.
    - imagePrompt: (Optional) A descriptive prompt for a premium 3D illustration.

Content Guidelines:
1. Start with a "Big Picture" placard.
2. Provide deeply simple explanations with relatable analogies.
3. Include "Did you know?" facts or "Pro-tips".
4. Ensure real-life examples are vivid and diverse.
5. Use Grade ${grade} level vocabulary.`,
    user: (title: string, content: string) =>
      `Topic: ${title}\n\nDocument Content:\n${content}`,
  },
};