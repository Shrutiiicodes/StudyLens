/**
 * Smoke test for the predicate ontology loader.
 *
 * Run: npx tsx scripts/verify-predicates.ts
 * Exit 0 on success, 1 on any failure.
 *
 * Checks mirror backend/scripts/verify_predicates.py so a drift between
 * the two loaders would show up as one passing and the other failing.
 */
import {
    PREDICATE_SPECS,
    PREDICATE_NAMES,
    ALLOWED_PREDICATES,
    ASYMMETRIC_PREDICATES,
    DAG_RELATIONS,
    PREDICATE_RUBRIC,
} from '../src/config/predicates';

const REQUIRED = new Set([
    'IS_A', 'PART_OF', 'REQUIRES', 'PRECEDES', 'EXTENSION_OF',
    'CAUSES', 'LED_TO', 'FOUND_IN', 'LOCATED_IN',
    'CONTRASTS_WITH', 'RELATES_TO',
]);

const SNAKE_CASE = /^[A-Z][A-Z0-9_]*$/;

const errors: string[] = [];
const check = (cond: boolean, msg: string) => {
    if (!cond) errors.push(msg);
};

// 1 + 2. Sanity floor
check(PREDICATE_SPECS.length >= 20,
    `Only ${PREDICATE_SPECS.length} predicates loaded (expected >= 20)`);

// 3. Required fields
PREDICATE_SPECS.forEach((p, i) => {
    check(!!p.name, `predicate[${i}]: empty name`);
    check(typeof p.description === 'string', `${p.name}: description not string`);
    check(typeof p.example === 'string', `${p.name}: example not string`);
    check(typeof p.asymmetric === 'boolean', `${p.name}: asymmetric not bool`);
    check(typeof p.dag === 'boolean', `${p.name}: dag not bool`);
});

// 4. No duplicates
const seen = new Set<string>();
const dupes = new Set<string>();
for (const n of PREDICATE_NAMES) {
    if (seen.has(n)) dupes.add(n);
    seen.add(n);
}
check(dupes.size === 0, `Duplicate predicates: ${[...dupes].sort().join(', ')}`);

// 5 + 6. Name shape
for (const n of PREDICATE_NAMES) {
    check(!n.includes(' '), `'${n}' contains whitespace`);
    check(SNAKE_CASE.test(n), `'${n}' is not UPPER_SNAKE_CASE`);
}

// 7. Subsets
const strayAsym = [...ASYMMETRIC_PREDICATES].filter((n) => !ALLOWED_PREDICATES.has(n));
const strayDag = [...DAG_RELATIONS].filter((n) => !ALLOWED_PREDICATES.has(n));
check(strayAsym.length === 0, `ASYMMETRIC not in ALLOWED: ${strayAsym}`);
check(strayDag.length === 0, `DAG not in ALLOWED: ${strayDag}`);

// 8. DAG => asymmetric
const dagNotAsym = [...DAG_RELATIONS].filter((n) => !ASYMMETRIC_PREDICATES.has(n));
check(dagNotAsym.length === 0,
    `DAG predicates must be asymmetric: ${dagNotAsym}`);

// 9. Rubric renders
check(PREDICATE_RUBRIC.length > 0, 'PREDICATE_RUBRIC is empty');
for (const n of PREDICATE_NAMES) {
    check(PREDICATE_RUBRIC.includes(n), `'${n}' missing from rubric`);
}

// 10. Regression guard
const missing = [...REQUIRED].filter((n) => !ALLOWED_PREDICATES.has(n));
check(missing.length === 0, `Required predicates missing: ${missing}`);

// Report
if (errors.length > 0) {
    console.log(`[verify-predicates] FAIL — ${errors.length} issue(s):`);
    for (const e of errors) console.log(`  ✘ ${e}`);
    process.exit(1);
}

console.log(
    `[verify-predicates] OK — ${PREDICATE_SPECS.length} predicates ` +
    `(${ASYMMETRIC_PREDICATES.size} asymmetric, ${DAG_RELATIONS.size} DAG)`,
);