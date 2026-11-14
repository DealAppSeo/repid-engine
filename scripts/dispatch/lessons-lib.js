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

/**
 * MEASURED GAP, 2026-08-28: the other two lesson channels are both capped —
 * LESSONS.md at 6000 chars (tests/lessons-injectable.test.ts), scoped pgvector
 * recall at SCOPED_CONTEXT_MAX=4000 (run-agent.mjs) — but this one, the domain
 * packs, had no cap at all. Currently harmless (4 packs, ~9KB combined), but a
 * brief whose text happens to trigger several packs, or one pack that grows over
 * time, would silently balloon the preamble with no test to catch it. Same shape
 * LESSONS §3 warns about: a mechanism wired at one end (the loader) without a
 * limit at the other (what gets injected).
 */
const PACKS_MAX = 4000;

/**
 * Split a pack body into its intro (everything before the first `## ` heading) and its
 * sections (each `## ` heading with the text under it). A pack with no `## ` headings is
 * one section with no intro. Sections are the unit of selection: never cut mid-section.
 */
function splitSections(body) {
  const lines = String(body || '').split(/\r?\n/);
  const intro = [];
  const sections = [];
  let cur = null;
  for (const line of lines) {
    if (/^## /.test(line)) {
      // A heading with no text would be listed in the footer as a blank name: name it instead.
      cur = { title: line.replace(/^##\s+/, '').trim() || `(untitled section ${sections.length + 1})`, lines: [line] };
      sections.push(cur);
    } else if (cur) cur.lines.push(line);
    else intro.push(line);
  }
  if (sections.length === 0) return { intro: '', sections: [{ title: '(whole pack)', text: String(body || '').trim() }] };
  return { intro: intro.join('\n').trim(), sections: sections.map((s) => ({ title: s.title, text: s.lines.join('\n').trim() })) };
}

/** Distinct words of 4+ letters in the brief: the relevance signal for ranking sections. */
function briefWords(brief) {
  return [...new Set(String(brief || '').toLowerCase().match(/[a-z0-9][a-z0-9-]{3,}/g) || [])];
}
const triggerHits = (pack, hay) => pack.triggers.filter((t) => hay.includes(t)).length;
const wordHits = (text, words) => { const t = text.toLowerCase(); return words.filter((w) => t.includes(w)).length; };

/**
 * Choose what to inject from the matched packs, within `max` characters.
 *
 * MEASURED GAP, 2026-11-14 (the reason this replaced whole-pack rendering): packs were
 * added whole in file order, and a later pack that did not fit was DROPPED SILENTLY while
 * the dispatcher still logged it as matched. A T12 known-answer brief matches both
 * `dispatch` and `hal-eval`; the two together exceeded the budget, so the HAL lessons
 * never reached the agent that most needed them. That is forgetting, not a size limit.
 *
 * Now:
 *   - packs are ranked by how many of their triggers the brief hits, and sections within a
 *     pack by how many of the brief's words they contain (both stable on ties);
 *   - the budget is filled in rounds: in each round every pack adds its most relevant
 *     remaining section that still fits, so every matched pack gets in (if any of its
 *     sections fits at all) before any pack gets a second;
 *   - a section is included whole or not at all; a pack's intro rides with its first section;
 *   - NOTHING IS DROPPED SILENTLY: every matched section that did not fit is named in a
 *     short footer that points at its file, and returned in `omitted` for the caller to log;
 *   - if not even one section fits, the best one is included anyway, so an oversized
 *     section is visibly too big (and gets trimmed at the source) rather than an empty block
 *     that reads as "no domain lessons matched" when some did.
 *
 * Returns { text, included: [{ pack, title }], omitted: [{ pack, title }] }.
 */
function selectPacks(matched, brief = '', max = PACKS_MAX) {
  if (!matched || matched.length === 0) return { text: '', included: [], omitted: [] };
  const hay = String(brief || '').toLowerCase();
  const words = briefWords(brief);
  const ranked = matched
    .map((p, i) => ({ p, i, hits: triggerHits(p, hay) }))
    .sort((a, b) => b.hits - a.hits || a.i - b.i)
    .map(({ p }) => {
      const { intro, sections } = splitSections(p.body);
      const order = sections
        .map((s, j) => ({ ...s, j, hits: wordHits(s.text, words) }))
        .sort((a, b) => b.hits - a.hits || a.j - b.j);
      return { name: p.name, intro, sections, order, chosen: new Set() };
    });

  let used = 0;
  const cost = (pk, s) => s.text.length + 2 + (pk.chosen.size === 0 && pk.intro ? pk.intro.length + 2 : 0);
  // Each round, every pack takes its most relevant REMAINING section that still fits. Taking
  // only its single best section would leave a pack with nothing whenever that one section is
  // too big for what is left, even though a smaller section of it would fit (measured: a
  // brief matching all four packs left one pack out entirely).
  let added = true;
  while (added) {
    added = false;
    for (const pk of ranked) {
      const s = pk.order.find((x) => !pk.chosen.has(x.j) && used + cost(pk, x) <= max);
      if (s) { used += cost(pk, s); pk.chosen.add(s.j); added = true; }
    }
  }
  if (used === 0) { const top = ranked[0]; top.chosen.add(top.order[0].j); } // visibly too big beats silently empty

  const included = [];
  const omitted = [];
  const blocks = [];
  for (const pk of ranked) {
    const kept = pk.sections.filter((_, j) => pk.chosen.has(j)); // file order reads best
    for (const [j, s] of pk.sections.entries()) (pk.chosen.has(j) ? included : omitted).push({ pack: pk.name, title: s.title });
    if (kept.length) blocks.push([pk.intro, ...kept.map((s) => s.text)].filter(Boolean).join('\n\n'));
  }
  let text = blocks.join('\n\n');
  if (omitted.length) {
    const byPack = new Map();
    for (const o of omitted) byPack.set(o.pack, [...(byPack.get(o.pack) || []), o.title]);
    text += '\n\nAlso matched, left out for space (full text in lessons/<pack>.md): ' +
      [...byPack].map(([pack, titles]) => `${pack}: ${titles.join('; ')}`).join(' | ') + '.';
  }
  return { text, included, omitted };
}

/** The injected block only. Kept for callers that need just the text; see selectPacks. */
function renderPacks(matched, max = PACKS_MAX, brief = '') {
  return selectPacks(matched, brief, max).text;
}

/** One line per pack, for sessions that can open the files themselves: name, then section titles. */
function packIndex(packs) {
  return packs
    .map((p) => `- lessons/${p.name}.md: ${splitSections(p.body).sections.map((s) => s.title).join('; ')}`)
    .join('\n');
}

module.exports = { parseTriggers, stripTriggerHeader, loadPacks, matchPacks, splitSections, selectPacks, renderPacks, packIndex, PACKS_MAX, TRIGGER_RE };
