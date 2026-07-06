/**
 * CANARY PROMPTS — known-correct probes injected into the label stream (Goodhart/trust tripwire).
 * OUTPUT_PATH: src/decisioning/canary-corpus.ts
 * SPEC: PRIORITY_B_ANFIS_DECISIONING_CHARTER_v1.md §7.
 *
 * WHY: the verification floor labels REAL calls whose truth we do not independently know. Canaries are
 * prompts with a KNOWN-correct answer we DO control, injected into the same label stream. When the
 * family-disjoint jury labels a canary, jury-verdict-vs-known-answer DIVERGENCE is a direct read on the
 * jury's trustworthiness (a jury that flunks canaries cannot be trusted to label real calls). It is the
 * Goodhart tripwire: if the label pipeline is being gamed or the jury is miscalibrated, canaries catch it.
 *
 * REAL PROMPTS + REAL KNOWN ANSWERS (R4 NO THEATER): the SEED set below is small and deterministic —
 * unambiguous factual/computational prompts with a single objectively-correct answer and an `answer_check`
 * that verifies a candidate answer WITHOUT an LLM (exact/regex/numeric). No fabricated "gold labels",
 * no sampled placeholders. A larger corpus is being built separately by T12 (spec §7 note) and MERGES in
 * via loadCanaryCorpus(externalPath) — this loader accepts an external corpus FILE and validates it.
 *
 * ADVISORY PURITY (R3): pure. Loading a corpus and scoring divergence performs no routing and no DB write.
 * PROMOTION-GATED. A canary row is queued the same way a floor row is (decisioning_label_queue.sample_reason
 * = 'canary'); the jury labels it; divergence is computed here.
 */

import * as fs from 'fs';

/** Category of the known answer — determines how answer_check verifies a candidate. */
export type CanaryCheckKind = 'exact' | 'numeric' | 'regex' | 'contains';

export interface CanaryProbe {
  /** stable id (used as the label-queue seed + dedupe key). */
  id: string;
  prompt: string;
  /** the canonical known-correct answer (human-readable). */
  knownAnswer: string;
  checkKind: CanaryCheckKind;
  /**
   * The verifier params for checkKind:
   *  - exact:    normalized string equality to knownAnswer
   *  - numeric:  parse number, |candidate - expected| <= tolerance
   *  - regex:    RegExp source that must match
   *  - contains: normalized substring must be present
   */
  expected?: string;      // for regex source / contains needle (defaults to knownAnswer)
  tolerance?: number;     // for numeric
  /** human-readable provenance note (title/description) so a reviewer can trust the gold answer. */
  source: string;
  /**
   * The anti-fabrication gate (R19 provenance): a real http/https URL a reviewer can open to verify the
   * gold answer. External rows without a valid source_url are REJECTED as unprovenanced. Aligns with the
   * T12 corpus format {claim,label,domain,difficulty,source_title,source_url}. Optional on SEED probes,
   * which are ground-truth-by-computation/settled-fact (source names the ground truth in prose).
   */
  source_url?: string;
}

function norm(s: string): string {
  return (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** True iff `s` parses as a URL with an http/https scheme (the anti-fabrication provenance gate). */
export function isValidSourceUrl(s: unknown): s is string {
  if (typeof s !== 'string' || s.trim() === '') return false;
  try {
    const u = new URL(s.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Verify a candidate answer against a probe's known answer WITHOUT an LLM. Deterministic + auditable.
 * Returns true iff the candidate is correct by the probe's check.
 */
export function answerIsCorrect(probe: CanaryProbe, candidate: string): boolean {
  const cand = candidate ?? '';
  switch (probe.checkKind) {
    case 'exact':
      return norm(cand) === norm(probe.knownAnswer);
    case 'contains': {
      const needle = norm(probe.expected ?? probe.knownAnswer);
      return norm(cand).includes(needle);
    }
    case 'numeric': {
      const expected = Number(probe.expected ?? probe.knownAnswer);
      // pull the first number out of the candidate (tolerant of prose like "the answer is 4")
      const m = cand.match(/-?\d+(\.\d+)?/);
      if (!m) return false;
      const got = Number(m[0]);
      const tol = probe.tolerance ?? 0;
      return Number.isFinite(got) && Number.isFinite(expected) && Math.abs(got - expected) <= tol;
    }
    case 'regex': {
      try {
        return new RegExp(probe.expected ?? probe.knownAnswer, 'i').test(cand);
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

/**
 * SEED canary set — small, real, deterministic. Each has ONE objectively-correct answer verifiable
 * without an LLM. Deliberately minimal (the big corpus arrives from T12); these exist so the tripwire
 * works today. NO synthetic/sampled labels.
 */
export const SEED_CANARIES: readonly CanaryProbe[] = Object.freeze([
  {
    id: 'canary-arith-1',
    prompt: 'What is 17 multiplied by 4? Answer with the number only.',
    knownAnswer: '68',
    checkKind: 'numeric',
    tolerance: 0,
    source: 'arithmetic (ground truth by computation)',
  },
  {
    id: 'canary-geo-capital-fr',
    prompt: 'What is the capital city of France?',
    knownAnswer: 'Paris',
    checkKind: 'contains',
    expected: 'paris',
    source: 'geography (settled fact)',
  },
  {
    id: 'canary-units-1',
    prompt: 'How many centimeters are in one meter? Answer with the number only.',
    knownAnswer: '100',
    checkKind: 'numeric',
    tolerance: 0,
    source: 'SI unit definition (1 m = 100 cm)',
  },
  {
    id: 'canary-bool-1',
    prompt: 'Is 7 a prime number? Answer yes or no.',
    knownAnswer: 'yes',
    checkKind: 'regex',
    expected: '\\byes\\b',
    source: 'number theory (7 is prime)',
  },
  {
    id: 'canary-chem-water',
    prompt: 'What is the chemical formula for water?',
    knownAnswer: 'H2O',
    checkKind: 'regex',
    expected: 'h\\s*2\\s*o',
    source: 'chemistry (settled fact)',
  },
]);

/**
 * Ids of the built-in SEED canaries — IMMUTABLE. An external corpus row may NOT reuse one of these ids;
 * a collision would let an untrusted file silently redefine a trusted probe (A3 seed poisoning), so the
 * loader rejects it loudly. Derived from SEED_CANARIES so the two can never drift.
 */
export const SEED_CANARY_IDS: ReadonlySet<string> = new Set(SEED_CANARIES.map((p) => p.id));

/** Result of validating an external corpus file before merging it into the canary stream. */
export interface CorpusLoadResult {
  probes: CanaryProbe[];
  /** rows rejected during validation, with the reason (no silent drop — R4). */
  rejected: Array<{ index: number; reason: string }>;
  source: string;
}

const VALID_KINDS = new Set<CanaryCheckKind>(['exact', 'numeric', 'regex', 'contains']);

/**
 * Validate a single external row into a CanaryProbe or a rejection reason. Enforces the real-probe
 * contract: id/prompt/knownAnswer/source non-empty, checkKind valid, numeric probes carry a finite
 * expected, regex probes compile. A row failing any check is REJECTED (listed), never coerced.
 */
export function validateCanaryRow(row: unknown, index: number): { ok: true; probe: CanaryProbe } | { ok: false; reason: string } {
  if (typeof row !== 'object' || row === null) return { ok: false, reason: 'not an object' };
  const r = row as Record<string, unknown>;
  // `source` provenance note may arrive under the T12 field name `source_title`.
  const sourceText = typeof r.source === 'string' ? r.source : typeof r.source_title === 'string' ? r.source_title : undefined;
  if (typeof sourceText !== 'string' || sourceText.trim() === '') {
    return { ok: false, reason: 'missing/empty required string field "source" (or "source_title")' };
  }
  const req = ['id', 'prompt', 'knownAnswer', 'checkKind'] as const;
  for (const k of req) {
    if (typeof r[k] !== 'string' || (r[k] as string).trim() === '') {
      return { ok: false, reason: `missing/empty required string field "${k}"` };
    }
  }
  // ANTI-FABRICATION GATE (A3): external rows MUST carry a real http/https source_url — no URL = unprovenanced.
  if (!isValidSourceUrl(r.source_url)) {
    return { ok: false, reason: 'unprovenanced: missing/invalid source_url (require a real http/https URL)' };
  }
  const kind = r.checkKind as string;
  if (!VALID_KINDS.has(kind as CanaryCheckKind)) {
    return { ok: false, reason: `invalid checkKind "${kind}" (want exact|numeric|regex|contains)` };
  }
  const probe: CanaryProbe = {
    id: r.id as string,
    prompt: r.prompt as string,
    knownAnswer: r.knownAnswer as string,
    checkKind: kind as CanaryCheckKind,
    source: sourceText,
    source_url: (r.source_url as string).trim(),
  };
  if (typeof r.expected === 'string') probe.expected = r.expected;
  if (typeof r.tolerance === 'number') probe.tolerance = r.tolerance;

  if (kind === 'numeric') {
    const exp = Number(probe.expected ?? probe.knownAnswer);
    if (!Number.isFinite(exp)) return { ok: false, reason: 'numeric probe: expected/knownAnswer is not a finite number' };
  }
  if (kind === 'regex') {
    try {
      new RegExp(probe.expected ?? probe.knownAnswer);
    } catch (e) {
      return { ok: false, reason: `regex probe: pattern does not compile (${(e as Error).message})` };
    }
  }
  return { ok: true, probe };
}

/**
 * Load a canary corpus. With no path -> the SEED set. With a path -> parse the JSON array, validate every
 * row, and report rejects. Accepts an EXTERNAL corpus file (the T12-built corpus merges here). External
 * rows must provenance a real http/https source_url (A3 anti-fabrication gate). SEED ids are IMMUTABLE:
 * an external row reusing a SEED id is rejected (A3 seed protection), and duplicate ids WITHIN the file
 * are rejected (A3 intra-file dedupe) rather than silently last-winning. Never throws on a bad row — it
 * rejects and lists it (R4: no silent drop).
 *
 * @param externalPath optional path to a JSON file: `CanaryProbe[]`
 * @param includeSeed  merge the built-in SEED set (default true)
 */
export function loadCanaryCorpus(externalPath?: string, includeSeed = true): CorpusLoadResult {
  const rejected: Array<{ index: number; reason: string }> = [];
  const byId = new Map<string, CanaryProbe>();

  if (includeSeed) {
    for (const p of SEED_CANARIES) byId.set(p.id, p);
  }

  let source = includeSeed ? 'SEED_CANARIES' : '(none)';
  if (externalPath) {
    source = includeSeed ? `SEED_CANARIES + ${externalPath}` : externalPath;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(externalPath, 'utf8'));
    } catch (e) {
      // The file itself is unreadable/invalid JSON — surface loudly, return seed-only (no fabrication).
      rejected.push({ index: -1, reason: `corpus file unreadable/invalid JSON: ${(e as Error).message}` });
      return { probes: [...byId.values()], rejected, source };
    }
    if (!Array.isArray(parsed)) {
      rejected.push({ index: -1, reason: 'corpus root is not a JSON array of CanaryProbe' });
      return { probes: [...byId.values()], rejected, source };
    }
    const seenExternalIds = new Set<string>();
    parsed.forEach((row, i) => {
      const res = validateCanaryRow(row, i);
      if (!res.ok) {
        rejected.push({ index: i, reason: res.reason });
        return;
      }
      const id = res.probe.id;
      // A3.1 SEED PROTECTION: seeds are immutable — an external row may NOT override a built-in SEED id.
      if (SEED_CANARY_IDS.has(id)) {
        rejected.push({ index: i, reason: `id "${id}" collides with an immutable SEED canary (seeds cannot be overridden)` });
        return;
      }
      // A3.2 INTRA-FILE DEDUPE: a duplicate id within the file is rejected loudly, never silently last-wins.
      if (seenExternalIds.has(id)) {
        rejected.push({ index: i, reason: `duplicate id "${id}" within external corpus` });
        return;
      }
      seenExternalIds.add(id);
      byId.set(id, res.probe);
    });
  }

  return { probes: [...byId.values()], rejected, source };
}

export interface CanaryDivergence {
  probeId: string;
  /** fraction of jury judges that got the canary WRONG (0 = perfect, 1 = all wrong). */
  divergence: number;
  correctCount: number;
  wrongCount: number;
  juryN: number;
}

/**
 * Compute jury-vs-known divergence for a canary: given each judge's answer string, verify each against
 * the probe's known answer (LLM-free) and return the fraction that diverged from truth. Higher = the
 * jury is LESS trustworthy on a case whose answer we actually know (the tripwire signal).
 *
 * @param probe        the canary (carries the known answer + check)
 * @param juryAnswers  one answer string per judge
 */
export function canaryDivergence(probe: CanaryProbe, juryAnswers: string[]): CanaryDivergence {
  const juryN = juryAnswers.length;
  let correct = 0;
  for (const a of juryAnswers) if (answerIsCorrect(probe, a)) correct++;
  const wrong = juryN - correct;
  return {
    probeId: probe.id,
    divergence: juryN > 0 ? wrong / juryN : 0,
    correctCount: correct,
    wrongCount: wrong,
    juryN,
  };
}
