/**
 * lessons-lib.js — pure logic for the domain-pack second tier of LESSONS.md.
 *
 * CommonJS on purpose: run-agent.mjs is ESM and this repo's jest is CommonJS, so a
 * `.mjs` cannot be `require`d by a test (and on Windows `import()` of an absolute
 * `c:\` path throws ERR_UNSUPPORTED_ESM_URL_SCHEME — the exact reason a chunk of the
 * suite is red locally). The pure decisions live here once: the ESM runner imports
 * it, the test requires it, no second copy to drift. Same pattern as sprint-lib.js.
 *
 * WHY SUBSTRING, NOT EXACT (LESSONS §5). Keyword matching FAILS OPEN: a brief that
 * says "proof system" with an exact trigger of "plonky3" would silently not load the
 * pack, giving you a rule that exists and did not apply. So triggers match as
 * case-insensitive substrings, and every pack must declare >=1 trigger — a pack with
 * none can never fire and is caught by the fixture test.
 */
const fs = require('node:fs');
const path = require('node:path');

const TRIGGER_RE = /<!--\s*triggers:\s*([^>]*?)\s*-->/i;

/** Extract lowercased triggers from a pack's `<!-- triggers: a b, c -->` header. */
function parseTriggers(text) {
  const m = String(text).match(TRIGGER_RE);
  if (!m) return [];
  return m[1]
    .split(/[\s,]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

/** Remove the trigger header so it is not injected into the agent's context. */
function stripTriggerHeader(text) {
  return String(text).replace(TRIGGER_RE, '').replace(/^\s*\n/, '');
}

/**
 * Load every pack in a directory. Returns `[{ name, triggers, body }]`. A pack with
 * no triggers is returned with `triggers: []` so the fixture test can FAIL it rather
 * than the loader hiding it.
 */
function loadPacks(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
  return files.sort().map((f) => {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    return {
      name: f.replace(/\.md$/, ''),
      triggers: parseTriggers(raw),
      body: stripTriggerHeader(raw).trim(),
    };
  });
}

/**
 * Pure: which packs match the dispatch text. A pack matches when ANY of its triggers
 * appears as a case-insensitive substring of the text. Packs with no triggers never
 * match (they cannot silently load with an empty trigger set).
 */
function matchPacks(dispatchText, packs) {
  const hay = String(dispatchText || '').toLowerCase();
  return packs.filter((p) => p.triggers.length > 0 && p.triggers.some((t) => hay.includes(t)));
}

/** Render matched packs as one block to append after LESSONS.md, before the brief. */
function renderPacks(matched) {
  if (!matched || matched.length === 0) return '';
  return matched.map((p) => p.body).join('\n\n');
}

module.exports = { parseTriggers, stripTriggerHeader, loadPacks, matchPacks, renderPacks, TRIGGER_RE };
