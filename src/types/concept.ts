export interface Concept {
    id: string;
    user_id: string;
    title: string;
    description?: string;
    source_document: string;
    created_at: string;
    mastery_score?: number;
    prerequisite_ids?: string[];
    status: ConceptStatus;
}

export type ConceptStatus = 'locked' | 'unlocked' | 'mastered';

export interface ConceptNode {
    id: string;
    label: string;
    type: 'concept' | 'definition' | 'example' | 'formula' | 'misconception';
    properties: Record<string, string>;
}

export interface ConceptRelation {
    source: string;
    target: string;
    type: 'EXPLAINS' | 'HAS_EXAMPLE' | 'PREREQUISITE' | 'CAUSES_CONFUSION_WITH';
}

export interface KnowledgeGraph {
    nodes: ConceptNode[];
    relations: ConceptRelation[];
}

export interface ExtractedKnowledge {
    concepts: Array<{
        name: string;
        definition: string;
        examples: string[];
        formulas: string[];
        misconceptions: string[];
    }>;
    relationships: Array<{
        from: string;
        to: string;
        type: string;
    }>;
}

export interface DocumentValidation {
    valid: boolean;
    wordCount: number;
    isAcademic: boolean;
    isDuplicate: boolean;
    conceptDensity: number;
    warnings: string[];
}
