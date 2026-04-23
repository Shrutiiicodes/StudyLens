import data from '../../shared/predicates.json';

export interface PredicateSpec {
    name: string;
    description: string;
    example: string;
    asymmetric: boolean;
    dag: boolean;
}

const SPECS: PredicateSpec[] = data.predicates;

export const PREDICATE_SPECS = SPECS;
export const PREDICATE_NAMES = SPECS.map((p) => p.name);
export const PREDICATE_LIST_PIPE = PREDICATE_NAMES.join(' | ');
export const ALLOWED_PREDICATES = new Set<string>(PREDICATE_NAMES);
export const ASYMMETRIC_PREDICATES = new Set<string>(
    SPECS.filter((p) => p.asymmetric).map((p) => p.name)
);
export const DAG_RELATIONS = new Set<string>(
    SPECS.filter((p) => p.dag).map((p) => p.name)
);

/** Human-readable rubric block, drop-in for the KG_EXTRACTOR prompt. */
export const PREDICATE_RUBRIC = SPECS.map((p) => {
    const head = `- ${p.name.padEnd(18)}→ ${p.description}`;
    return p.example ? `${head} ("${p.example}")` : head;
}).join('\n');

export type AllowedRelation = typeof PREDICATE_NAMES[number];