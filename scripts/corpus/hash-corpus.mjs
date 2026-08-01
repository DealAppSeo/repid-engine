#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

function printUsage() {
  console.log('Usage: node scripts/corpus/hash-corpus.mjs <path-to-jsonl-file>');
}

const args = process.argv.slice(2);
if (args.length !== 1) {
  printUsage();
  process.exit(1);
}

const filePath = path.resolve(args[0]);

if (!fs.existsSync(filePath)) {
  console.error(`Error: File not found at ${filePath}`);
  process.exit(1);
}

const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split(/\r?\n/);

const parsedRows = [];
let hasErrors = false;

for (let i = 0; i < lines.length; i++) {
  const lineNum = i + 1;
  const line = lines[i].trim();
  
  if (line === '') {
    // Skip empty lines
    continue;
  }

  let row;
  try {
    row = JSON.parse(line);
  } catch (err) {
    console.error(`Line ${lineNum}: Failed to parse JSON. Error: ${err.message}`);
    hasErrors = true;
    continue;
  }

  const errors = validateRow(row);
  if (errors.length > 0) {
    console.error(`Line ${lineNum} (id: ${row.id || 'N/A'}) failed schema validation:`);
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    hasErrors = true;
  } else {
    parsedRows.push(row);
  }
}

function validateRow(row) {
  const errors = [];
  
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    errors.push('Row is not a JSON object');
    return errors;
  }

  const expectedKeys = [
    'id', 'prompt', 'candidate_answer', 'label', 'category', 
    'source_url', 'source_retrieved_at', 'notes', 'split'
  ];

  const actualKeys = Object.keys(row);
  for (const key of actualKeys) {
    if (!expectedKeys.includes(key)) {
      errors.push(`Unexpected key found: "${key}"`);
    }
  }

  for (const key of expectedKeys) {
    if (!(key in row)) {
      errors.push(`Missing required key: "${key}"`);
      continue;
    }

    const value = row[key];
    if (typeof value !== 'string') {
      errors.push(`Key "${key}" must be a string, but found ${typeof value}`);
      continue;
    }

    if (key === 'id' && value.trim() === '') {
      errors.push('Key "id" cannot be an empty string');
    }

    if (key === 'label' && !['TRUE', 'FALSE', 'ABSTAIN'].includes(value)) {
      errors.push(`Key "label" must be one of TRUE, FALSE, ABSTAIN. Found: "${value}"`);
    }

    if (key === 'split' && !['train', 'holdout'].includes(value)) {
      errors.push(`Key "split" must be one of train, holdout. Found: "${value}"`);
    }

    if (key === 'source_retrieved_at') {
      const timestamp = Date.parse(value);
      if (isNaN(timestamp)) {
        errors.push(`Key "source_retrieved_at" must be a valid date/timestamp string. Found: "${value}"`);
      }
    }

    // PROVENANCE GATE. The corpus exists to be a ruler nobody can argue with, and a
    // row nobody can trace is not evidence — it is an assertion wearing evidence's
    // clothes. This has bitten before: an agent once produced 162 "independent"
    // examples that were all self-generated under one label.
    //
    // A real, resolvable source_url is therefore mandatory, and the placeholder the
    // format examples use is rejected by name so example.jsonl can never be promoted
    // into a real corpus by renaming the file.
    if (key === 'source_url') {
      if (/^EXAMPLE-NOT-REAL/i.test(value)) {
        errors.push('Key "source_url" is the format-example placeholder. A corpus row needs a real, checkable source.');
      } else {
        let parsed;
        try {
          parsed = new URL(value);
        } catch {
          errors.push(`Key "source_url" must be an absolute URL so a reviewer can re-verify the label. Found: "${value}"`);
        }
        if (parsed && !['http:', 'https:'].includes(parsed.protocol)) {
          errors.push(`Key "source_url" must be http(s). Found protocol: "${parsed.protocol}"`);
        }
      }
    }
  }

  return errors;
}

if (hasErrors) {
  console.error('Validation failed. Some rows did not conform to the schema.');
  process.exit(1);
}

if (parsedRows.length === 0) {
  console.error('Error: File contains no data rows.');
  process.exit(1);
}

// Canonicalize and sort keys recursively
function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(canonicalize);
  }
  const sortedKeys = Object.keys(obj).sort();
  const result = {};
  for (const key of sortedKeys) {
    result[key] = canonicalize(obj[key]);
  }
  return result;
}

const canonicalRows = parsedRows.map(row => canonicalize(row));

// Sort rows deterministically by id
canonicalRows.sort((a, b) => {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
});

// Check for duplicate IDs
const seenIds = new Set();
for (const row of canonicalRows) {
  if (seenIds.has(row.id)) {
    console.error(`Error: Duplicate ID found in corpus: "${row.id}"`);
    process.exit(1);
  }
  seenIds.add(row.id);
}

// HOLDOUT LEAK GATE. Distinct ids are not distinct CONTENT. If the same
// prompt+answer appears in train and in holdout, the holdout score is partly a
// memory test, and the number it produces reads as accuracy while measuring
// something else. That is the failure this whole corpus exists to end — the HAL
// F1 spread (0.34 / 0.74 / 0.886 / 0.890) is four rulers, not progress, and a
// leaked holdout would quietly add a fifth.
//
// Keyed on prompt+candidate_answer: the same prompt may legitimately appear with
// different candidate answers (that is a useful contrast pair); the same pair on
// both sides of the split never is.
const splitOf = new Map();
for (const row of canonicalRows) {
  const contentKey = JSON.stringify([row.prompt, row.candidate_answer]);
  const prior = splitOf.get(contentKey);
  if (prior && prior.split !== row.split) {
    console.error(
      `Error: HOLDOUT LEAK — identical prompt+candidate_answer appears in both splits ` +
      `("${prior.id}" in ${prior.split}, "${row.id}" in ${row.split}). ` +
      `A holdout that overlaps train measures recall of the training set, not accuracy.`,
    );
    process.exit(1);
  }
  if (!prior) splitOf.set(contentKey, { id: row.id, split: row.split });
}

// Serialize each sorted row back to standard minified JSON, separated by newline
const canonicalString = canonicalRows.map(row => JSON.stringify(row)).join('\n') + '\n';

// Compute SHA256 content hash
const hash = crypto.createHash('sha256').update(canonicalString).digest('hex');

console.log(hash);
