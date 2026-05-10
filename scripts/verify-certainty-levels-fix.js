#!/usr/bin/env node
/**
 * Verifies the certainty_levels_to_test reader pattern handles all
 * shapes observed in production plus defensive cases.
 *
 * Run: node scripts/verify-certainty-levels-fix.js
 * Exit: 0 if all assertions pass, 1 otherwise.
 *
 * Mirrors the exact read pattern used in src/services/hal-tester.ts
 * after the fix in fix/certainty-levels-data-shape-2026-05-09.
 */

function readCertainty(prompt) {
    return prompt.certainty_levels_to_test?.test?.[0] ?? 0.88;
}

const scenarios = [
    {
        name: 'shape 1 (most common in prod): {test:[0.88, 0.93]}',
        prompt: { certainty_levels_to_test: { test: [0.88, 0.93] } },
        expected: 0.88,
    },
    {
        name: 'shape 2 (also seen, e.g. HAL-T1-001): {test:[0.85, 0.90, 0.95]}',
        prompt: { certainty_levels_to_test: { test: [0.85, 0.90, 0.95] } },
        expected: 0.85,
    },
    {
        name: 'shape 3 (raw array — what the broken default suggested, never appears in data): falls back to 0.88',
        prompt: { certainty_levels_to_test: [0.5, 0.7, 0.85, 0.95] },
        expected: 0.88,
    },
    {
        name: 'shape 4 (defensive — null): falls back to 0.88',
        prompt: { certainty_levels_to_test: null },
        expected: 0.88,
    },
    {
        name: 'shape 5 (defensive — empty test array): falls back to 0.88',
        prompt: { certainty_levels_to_test: { test: [] } },
        expected: 0.88,
    },
    {
        name: 'defensive — column undefined entirely: falls back to 0.88',
        prompt: {},
        expected: 0.88,
    },
    {
        name: 'defensive — object exists but no .test key: falls back to 0.88',
        prompt: { certainty_levels_to_test: { other: [0.5] } },
        expected: 0.88,
    },
    {
        name: 'regression — legitimate 0 in test array preserved (not coerced to 0.88)',
        prompt: { certainty_levels_to_test: { test: [0, 0.5] } },
        expected: 0,
    },
];

let pass = 0;
let fail = 0;

for (const s of scenarios) {
    const got = readCertainty(s.prompt);
    if (got === s.expected) {
        console.log(`PASS  ${s.name}  →  ${got}`);
        pass++;
    } else {
        console.log(`FAIL  ${s.name}`);
        console.log(`      expected: ${s.expected}`);
        console.log(`      got:      ${got}`);
        fail++;
    }
}

console.log('');
console.log(`Total: ${scenarios.length}  Passed: ${pass}  Failed: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
