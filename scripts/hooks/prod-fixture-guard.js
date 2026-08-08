#!/usr/bin/env node
/**
 * prod-fixture-guard.js — refuse to COMMIT a fixture that looks like a production extract.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE INCIDENT THIS FENCES (PR #376), MADE PERMANENT
 * ════════════════════════════════════════════════════════════════════════════════
 * #376 committed a real Plonky3 proof row — an actual binary proof, a real agent UUID,
 * and the production table name it came from — under `tests/fixtures/`, as if it were a
 * test fixture. It was not synthetic. It was a row lifted out of the live database and
 * frozen into the repo, where (this repo being PUBLIC) it is now world-readable and
 * permanent. A real proof + a real agent id + the table they live in is a production
 * extract wearing a fixture's clothes.
 *
 * The permanent rule (the "#376 fence"): fixtures are SYNTHETIC / self-generated / KAT
 * only. If a test needs a proof, it GENERATES one offline. No live proof, no real
 * agent_id/UUID, no real score, and no prod table dump ever gets committed as a fixture.
 *
 * Every other secret control here scans for CREDENTIAL shapes (gitleaks, the publication
 * guard). A production proof row is not a credential — it has no `sk-`/`eyJ` shape — so
 * none of them see it. This guard is the one that recognises the shape of a production
 * EXTRACT rather than the shape of a key.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT IT BLOCKS
 * ════════════════════════════════════════════════════════════════════════════════
 * (1) BINARY PROOF FIXTURES under tests/  — `*.plonky3.bin`, `*proof*.bin`, and any
 *     `.bin` whose name reads proof/plonky3/nullifier/leaf/attestation — UNLESS the
 *     filename explicitly marks it synthetic/KAT (`.synthetic.` / `.kat.` / `-synthetic`
 *     / `-kat`). A binary carries no in-file marker, so the name is the only channel.
 *
 * (2) FIXTURE CONTENT (tests/fixtures/**) that names a PRODUCTION TABLE
 *     (repid_zkp_proofs, repid_score_events, repid_agents, hal_production_events)
 *     alongside a UUID, OR alongside a provenance string ("captured from",
 *     "extracted from", "exported from production", …). A provenance string is a
 *     confession — it wins even over a SYNTHETIC marker, because "extracted from prod"
 *     and "synthetic" cannot both be true and the extraction is the dangerous reading.
 *
 * (3) FIXTURE CONTENT that carries a PROOF / SCORE / AGENT SHAPE (a prod table name, or
 *     JSON keys like "proof_bytes", "nullifier_hash", "current_repid",
 *     "erc8004_address", "eas_uid", …) WITHOUT an explicit SYNTHETIC or KAT marker.
 *     The marker is a deliberate, uppercase, in-content assertion by the author that the
 *     data was generated, not extracted. Fixtures that carry these shapes must say so.
 *
 * Ordinary corpora (deception text, HAL regression cases, prose that merely mentions
 * "Plonky3") carry none of these shapes and pass untouched — the shape detector keys off
 * JSON-key syntax and table names, not prose.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * FAIL-CLOSED, WITH A DOCUMENTED BYPASS
 * ════════════════════════════════════════════════════════════════════════════════
 * Default is fail-closed: an unmarked proof/score/agent fixture is BLOCKED. The worst
 * case of a false negative (a real prod row committed to a public repo) cannot be
 * withdrawn, so the guard errs toward blocking.
 *
 * Genuine false positives have ONE documented escape, and it is loud and deliberate:
 *
 *     ALLOW_PROD_FIXTURE=1 git commit ...
 *
 * That env override skips the guard and prints WHY it was skipped to stderr, so the
 * bypass is never silent. Prefer marking the fixture SYNTHETIC/KAT over using it.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * INVOCATION
 * ════════════════════════════════════════════════════════════════════════════════
 *   node scripts/hooks/prod-fixture-guard.js --staged    # pre-commit: staged files only
 *   node scripts/hooks/prod-fixture-guard.js --ci        # CI: every file under tests/
 *   node scripts/hooks/prod-fixture-guard.js <file>...   # explicit files (used by tests)
 *
 * Exit 0 = clean. Exit 2 = at least one file blocked (message on stderr names the rule).
 */

'use strict';

const { execFileSync } = require('node:child_process');
const { readFileSync, existsSync, readdirSync, statSync } = require('node:fs');
const { join, basename, posix } = require('node:path');

const PROD_TABLES = ['repid_zkp_proofs', 'repid_score_events', 'repid_agents', 'hal_production_events'];

/** A prod table name anywhere in the text. */
const PROD_TABLE_RE = new RegExp(`\\b(${PROD_TABLES.join('|')})\\b`);

/** RFC-4122-shaped UUID (any version). Real agent ids and proof ids look like this. */
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/;

/**
 * A provenance confession: the fixture says, in words, that it came out of production.
 * This is the "captured from" / "extracted from" clause rule (2) calls out, and it is a
 * HARD block — a marker cannot un-say it.
 */
const PROVENANCE_RE =
  /\b(captured|extracted|exported|dumped|copied|pulled|lifted|snapshotted)\s+(from|out\s+of)\b|\bfrom\s+prod(uction)?\b|\bprod(uction)?[\s_-]*(row|dump|export|extract|snapshot)\b|"(captured_from|extracted_from|source_row_id|prod_row_id|exported_from)"/i;

/**
 * Proof/score/agent SHAPE — JSON keys that only a row of one of the sensitive tables
 * carries. Matched in quoted-key form (`"proof_bytes":`) so prose that merely says the
 * word "plonky3" or "attestation" does NOT trip it. A prod table name is also a shape.
 */
const SHAPE_KEY_RE =
  /"(proof_bytes|proof_data|proof_hash|plonky3_proof|nullifier(_hash)?|eas_uid|attestation_uid|attestation_id|current_repid|repid_earned|erc8004_address|score_delta|epoch_root|fold_root|commitment_hash)"\s*:/i;

/**
 * Explicit synthetic / KAT marker inside the file content. Uppercase and word-bounded so
 * it is a deliberate assertion, not an accident of prose. `SYNTHETIC`, `KAT`,
 * `SYNTHETIC_FIXTURE`, `KAT_VECTOR` all qualify.
 */
const CONTENT_MARKER_RE = /\b(SYNTHETIC|KAT)\b/;

/** Filename-level marker — the only marker channel a binary blob has. */
const FILENAME_MARKER_RE = /(^|[._-])(synthetic|kat)([._-]|$)/i;

/** Binary proof blob by name. */
const BINARY_PROOF_RE = /\.plonky3\.bin$|proof[^/]*\.bin$|[^/]*proof\.bin$|\.(bin|proof|plonky3)$/i;
const BINARY_PROOF_NAME_HINT_RE = /(proof|plonky3|nullifier|leaf|attestation)/i;

/** Extensions we treat as opaque binary — filename rule only, never content-scanned. */
const BINARY_EXT_RE = /\.(bin|proof|plonky3|wasm|zkey|ptau)$/i;

function toPosix(p) {
  return p.replace(/\\/g, '/');
}

function underTests(relPath) {
  const p = toPosix(relPath);
  return p === 'tests' || p.startsWith('tests/') || p.includes('/tests/');
}

function underFixtures(relPath) {
  return toPosix(relPath).includes('tests/fixtures/');
}

function hasFilenameMarker(relPath) {
  return FILENAME_MARKER_RE.test(basename(toPosix(relPath)));
}

function isBinaryPath(relPath) {
  return BINARY_EXT_RE.test(toPosix(relPath));
}

/**
 * Is this a proof-blob filename under tests/? A `.bin` (or `.plonky3.bin`) whose name
 * reads like a proof, plus the explicit `*.plonky3.bin` shape regardless of hint.
 */
function isBinaryProofPath(relPath) {
  const p = toPosix(relPath);
  if (!underTests(p)) return false;
  const name = basename(p);
  if (/\.plonky3\.bin$/i.test(name)) return true;
  if (!BINARY_PROOF_RE.test(name)) return false;
  return BINARY_PROOF_NAME_HINT_RE.test(name) || /\.plonky3\.bin$/i.test(name);
}

/**
 * The core decision. Pure and content-in — the tests drive this directly with synthetic
 * strings, so nothing here reads the disk or needs a real proof to exist.
 *
 * @param {{ relPath: string, content?: string|null, isBinary?: boolean }} file
 * @returns {{ blocked: boolean, rule?: number, reason?: string, name: string }}
 */
function evaluateFixture(file) {
  const relPath = toPosix(file.relPath);
  const name = relPath;
  const binary = file.isBinary ?? isBinaryPath(relPath);

  // ── Rule (1): binary proof blobs under tests/ must be marked synthetic/KAT by name.
  if (binary) {
    if (isBinaryProofPath(relPath) && !hasFilenameMarker(relPath)) {
      return {
        blocked: true,
        rule: 1,
        name,
        reason:
          `binary proof fixture "${basename(relPath)}" under tests/ is not marked synthetic. ` +
          `A committed .bin proof is a production extract unless it was generated offline. ` +
          `Rename it to carry a .synthetic. / .kat. token, or generate it in the test instead.`,
      };
    }
    return { blocked: false, name };
  }

  // Content rules (2) & (3) apply to fixture data files only — not test SOURCE, which
  // legitimately names tables and could carry a UUID in an assertion.
  if (!underFixtures(relPath)) return { blocked: false, name };

  const content = file.content ?? '';
  const hasProdTable = PROD_TABLE_RE.test(content);
  const hasUUID = UUID_RE.test(content);
  const hasProvenance = PROVENANCE_RE.test(content);
  const hasShape = hasProdTable || SHAPE_KEY_RE.test(content);
  const hasMarker = CONTENT_MARKER_RE.test(content) || hasFilenameMarker(relPath);

  // Rule (2), strong form: a provenance confession next to prod-shaped data. A marker
  // cannot save this — "extracted from prod" and "synthetic" contradict, extraction wins.
  if (hasProvenance && (hasProdTable || hasUUID || hasShape)) {
    return {
      blocked: true,
      rule: 2,
      name,
      reason:
        `fixture names a production extraction ("captured/extracted from …") alongside a ` +
        `production table, UUID, or proof/score/agent shape. This is a prod extract, not a ` +
        `fixture — even a SYNTHETIC marker cannot override an explicit provenance string.`,
    };
  }

  // Rule (2): a prod table name next to a UUID, unmarked. This is exactly the #376 shape
  // (repid_zkp_proofs + a real agent UUID) minus the binary blob.
  if (hasProdTable && hasUUID && !hasMarker) {
    return {
      blocked: true,
      rule: 2,
      name,
      reason:
        `fixture pairs a production table name with a UUID and carries no SYNTHETIC/KAT ` +
        `marker — the #376 shape (a prod row frozen as a fixture). Mark it synthetic if the ` +
        `id is generated, or generate the data in the test.`,
    };
  }

  // Rule (3): any proof/score/agent shape must be explicitly marked synthetic/KAT.
  if (hasShape && !hasMarker) {
    return {
      blocked: true,
      rule: 3,
      name,
      reason:
        `fixture carries a proof/score/agent shape (a production table name or a row key ` +
        `like "proof_bytes"/"current_repid"/"erc8004_address") but no SYNTHETIC or KAT ` +
        `marker. Add an explicit marker asserting the data is generated, not extracted.`,
    };
  }

  return { blocked: false, name };
}

/** Read a text file for content scanning; binary files are never read. */
function loadFile(absPath, relPath) {
  if (isBinaryPath(relPath)) return { relPath, content: null, isBinary: true };
  let content = '';
  try {
    content = readFileSync(absPath, 'utf8');
  } catch {
    content = '';
  }
  return { relPath, content, isBinary: false };
}

/** Staged, added/copied/modified files (pre-commit mode). */
function stagedFiles(repoRoot) {
  let out = '';
  try {
    out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  } catch {
    return [];
  }
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Every file under tests/ (CI mode). */
function walkTests(repoRoot) {
  const root = join(repoRoot, 'tests');
  const acc = [];
  if (!existsSync(root)) return acc;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        stack.push(full);
      } else if (e.isFile()) {
        acc.push(toPosix(full.slice(repoRoot.length + 1)));
      }
    }
  }
  return acc;
}

function repoRootOf(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    return cwd;
  }
}

function main(argv) {
  const args = argv.slice(2);

  if (process.env.ALLOW_PROD_FIXTURE === '1') {
    process.stderr.write(
      `[prod-fixture-guard] SKIPPED via ALLOW_PROD_FIXTURE=1 — the production-extract fence ` +
        `is bypassed for this run. Use this only for a verified false positive; prefer marking ` +
        `the fixture SYNTHETIC/KAT.\n`,
    );
    return 0;
  }

  const repoRoot = repoRootOf(process.cwd());

  let relFiles;
  if (args.includes('--staged')) {
    relFiles = stagedFiles(repoRoot).filter((f) => underTests(f));
  } else if (args.includes('--ci') || args.includes('--all')) {
    relFiles = walkTests(repoRoot);
  } else {
    // Explicit file paths (used by the test suite and ad-hoc checks).
    relFiles = args.filter((a) => !a.startsWith('--')).map(toPosix);
  }

  const blocked = [];
  for (const rel of relFiles) {
    const abs = join(repoRoot, rel);
    // Explicit-path mode may pass files that don't exist on disk; skip those silently.
    if (!existsSync(abs)) continue;
    try {
      if (statSync(abs).isDirectory()) continue;
    } catch {
      continue;
    }
    const loaded = loadFile(abs, rel);
    const verdict = evaluateFixture(loaded);
    if (verdict.blocked) blocked.push(verdict);
  }

  if (blocked.length > 0) {
    process.stderr.write(
      `\n===============================================================\n` +
        `[prod-fixture-guard] COMMIT BLOCKED — production-extract fixture(s) detected\n` +
        `===============================================================\n`,
    );
    for (const b of blocked) {
      process.stderr.write(`  ✗ ${b.name}\n      rule ${b.rule}: ${b.reason}\n`);
    }
    process.stderr.write(
      `\n  The #376 fence: fixtures are SYNTHETIC / self-generated / KAT ONLY. Never commit\n` +
        `  a real proof, a real agent_id/UUID, a real score, or a prod table dump as a fixture.\n` +
        `  If a test needs a proof, GENERATE it offline in the test.\n\n` +
        `  Documented bypass for a verified false positive (loud, not silent):\n` +
        `    ALLOW_PROD_FIXTURE=1 git commit ...\n` +
        `===============================================================\n`,
    );
    return 2;
  }

  return 0;
}

module.exports = {
  evaluateFixture,
  isBinaryProofPath,
  isBinaryPath,
  hasFilenameMarker,
  underTests,
  underFixtures,
  walkTests,
  stagedFiles,
  main,
  PROD_TABLES,
  PROD_TABLE_RE,
  UUID_RE,
  PROVENANCE_RE,
  SHAPE_KEY_RE,
  CONTENT_MARKER_RE,
};

if (require.main === module) {
  try {
    process.exit(main(process.argv));
  } catch (e) {
    // Fail closed: an error inside the fence blocks the commit rather than waving it through.
    process.stderr.write(
      `[prod-fixture-guard] BLOCKED — the guard itself failed (${e && e.message}). ` +
        `Refusing to commit unscanned fixtures. Bypass with ALLOW_PROD_FIXTURE=1 if verified safe.\n`,
    );
    process.exit(2);
  }
}
