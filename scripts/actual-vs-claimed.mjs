/**
 * Print claimed vs actual values from local fixtures only.
 *
 * Reads a claims fixture and a directory of receipt files. Each row is:
 *   claim    actual    status
 *
 * - status is NOT_CHECKED when no local receipt file exists for the claim.
 * - a missing or invalid actual value (including the number 0) is treated as
 *   NOT_CHECKED and is never printed as 0.
 * - status is MATCH when the receipt exists and actual equals claimed.
 * - status is MISMATCH when the receipt exists and actual differs.
 *
 * Does not call any external model, vendor, or any live stake / SQL path.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const claimsPath = join(here, 'fixtures', 'actual-vs-claimed-claims.json');
const receiptsDir = join(here, 'fixtures', 'receipts');
const HEADER = ['claim', 'actual', 'status'];

function fail(message) {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exit(1);
}

function isValidVerdict(value) {
  return value === 'TRUE' || value === 'FALSE';
}

function cell(value) {
  if (value === 0 || value === '0') return 'NOT_CHECKED';
  if (!isValidVerdict(value)) return 'NOT_CHECKED';
  return value;
}

const checkedZero = cell(0);
if (checkedZero !== 'NOT_CHECKED' || checkedZero === 0 || checkedZero === '0') {
  fail('missing actual printed 0');
}

const claimsFixture = JSON.parse(readFileSync(claimsPath, 'utf8'));
if (!Array.isArray(claimsFixture) || claimsFixture.length === 0) {
  fail('claims fixture is empty or not an array');
}

const receiptFiles = new Set(
  existsSync(receiptsDir) ? readdirSync(receiptsDir).filter((name) => name.endsWith('.json')) : []
);

const lines = [HEADER.join('\t')];
for (const claim of claimsFixture) {
  if (typeof claim.id !== 'string' || claim.id.length === 0) {
    fail('claim is missing a string id');
  }
  if (!isValidVerdict(claim.claimed)) {
    fail(`${claim.id} claimed is not TRUE or FALSE`);
  }

  const receiptName = `${claim.id}.json`;
  const receiptPath = join(receiptsDir, receiptName);
  const hasReceipt = receiptFiles.has(receiptName) && existsSync(receiptPath);

  let actual = 'NOT_CHECKED';
  let status = 'NOT_CHECKED';

  if (hasReceipt) {
    let receipt;
    try {
      receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    } catch {
      receipt = {};
    }
    actual = cell(receipt.actual);
    if (actual === 'NOT_CHECKED') {
      status = 'NOT_CHECKED';
    } else if (actual === claim.claimed) {
      status = 'MATCH';
    } else {
      status = 'MISMATCH';
    }
  }

  for (const value of [actual, status]) {
    if (value === 0 || value === '0') fail(`${claim.id} printed 0`);
  }

  lines.push([claim.id, actual, status].join('\t'));
}

process.stdout.write(`${lines.join('\n')}\n`);
