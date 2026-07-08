/**
 * Claim extraction + typing — the first half of the P0 "execution beats
 * explanation" law.
 *
 * Decomposes an output/claim into TYPED atomic claims. The TYPING itself is
 * DETERMINISTIC (rules + light parsing) — no LLM call is required to type a
 * claim. This is deliberate: the whole point of the execution-floor law is
 * that a claim's checkability is an objective property of the claim's SHAPE,
 * not an opinion. A model's guess about whether "2 + 2 = 5" is arithmetic is
 * inadmissible; the parser either recognizes the arithmetic shape or it does
 * not.
 *
 * Claim taxonomy (see `ClaimType`):
 *   - executable      → a deterministic checker can produce ground truth.
 *                       Carries an `executableKind` sub-type.
 *   - source-grounded → verifiable against an external source we can fetch
 *                       (a citation / URL / doc reference) but not via a
 *                       local deterministic checker.
 *   - probabilistic   → a prediction / forecast / opinion with a truth value
 *                       that is not yet decidable ("BTC will hit $100k").
 *   - unverifiable    → subjective / value / preference statements with no
 *                       decidable truth value ("this design is elegant").
 *
 * ADDITIVE + SHADOW-SAFE: this module has zero side effects and no I/O. It is
 * consumed by src/hal/execution-floor.ts, which is itself flag-gated
 * (EXECUTION_FLOOR_ENABLED, default OFF / shadow).
 */

export type ExecutableKind =
  | 'arithmetic' // pure math: "2 + 2 = 4", "10% of 250 = 25"
  | 'onchain' // an on-chain fact: address balance, tx existence, token lookup
  | 'db' // answerable by a scoped DB read
  | 'code' // a claim about code that would compile/test (NOT run here — see law)
  | 'citation'; // a reference we can resolve (DOI / arXiv / URL)

export type ClaimType =
  | 'executable'
  | 'source-grounded'
  | 'probabilistic'
  | 'unverifiable';

export interface TypedClaim {
  /** The atomic claim text (a single sentence / assertion). */
  content: string;
  /** The top-level claim type. */
  type: ClaimType;
  /** Present only when type === 'executable'. */
  executableKind?: ExecutableKind;
  /**
   * How checkable the claim is right now, in [0, 1]:
   *   1.0  — deterministically checkable by a wired checker (arithmetic, onchain)
   *   0.6  — checkable in principle but the checker is stubbed/not-run (code, db)
   *   0.4  — source-grounded (needs an external fetch)
   *   0.1  — probabilistic (decidable only in the future)
   *   0.0  — unverifiable (no decidable truth value)
   */
  checkability: number;
  /**
   * Structured payload the checker needs, populated by the recognizer for
   * executable claims. e.g. { lhs: "2 + 2", rhs: "4" } for arithmetic, or
   * { address, kind: 'balance' } for on-chain. Deterministic, no I/O.
   */
  parsed?: Record<string, unknown>;
}

// --------------------------------------------------------------------------
// Sentence segmentation — deterministic, dependency-free.
// --------------------------------------------------------------------------

/**
 * Split an output into candidate atomic claims. Keeps it simple + interpretable:
 * split on sentence terminators and hard newlines / list markers. Not a full
 * NLP sentence tokenizer — good enough to isolate individual assertions, which
 * is all the floor needs.
 */
export function segmentClaims(output: string): string[] {
  if (!output || typeof output !== 'string') return [];
  return output
    // break on newlines and common list markers first
    .split(/\r?\n+|(?:^|\s)[-*•]\s+/g)
    // then on sentence terminators, keeping the terminator out
    .flatMap((chunk) => chunk.split(/(?<=[.!?])\s+/g))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// --------------------------------------------------------------------------
// Recognizers — each is a pure predicate returning a partial TypedClaim or null.
// Order matters: the first matching executable recognizer wins.
// --------------------------------------------------------------------------

/**
 * Arithmetic claim: an equality/inequality whose sides are numeric expressions
 * built only from numbers and + - * / ( ) % and the words "of"/"percent".
 * We deliberately require an explicit relational operator (= / == / equals /
 * is / </>/≈) so we only claim to check *assertions*, not bare expressions.
 *
 * Two-pass: SYMBOLIC relations first (=, <=, ≈, …) because they unambiguously
 * split the math expression even inside prose ("The total is 2 + 2 = 5" locks
 * on the '='). Only when NO symbolic relation is present do we fall back to the
 * word operators ("equals" / "is"), which are prose-ambiguous.
 */
// Symbolic: match the LAST relation so "2 + 2 = 5" splits at '=', not a stray '<'.
const ARITH_RELATION_SYMBOLIC =
  /^(.*?)\s*(==|<=|>=|!=|≠|≈|=|<|>)\s*([^=<>≠≈]+)$/;
// Word operators (fallback only): "X equals Y", "X is Y".
const ARITH_RELATION_WORD =
  /(.+?)\s+(equals|is equal to|is|approximately)\s+(.+)/i;

function matchArithRelation(content: string): RegExpMatchArray | null {
  return content.match(ARITH_RELATION_SYMBOLIC) ?? content.match(ARITH_RELATION_WORD);
}

/** A math-expression token set: digits, operators, parens, %, decimal points, whitespace, and the word "of". */
const MATH_EXPR = /^[\s\d+\-*/().,%^]+$/;

function looksLikeMathExpr(s: string): boolean {
  const cleaned = s
    .replace(/\bpercent\b/gi, '%')
    .replace(/\bof\b/gi, '*') // "10% of 250" → "10% * 250"
    .replace(/,/g, ''); // thousands separators
  // must contain at least one digit and at least one operator (so "42" alone
  // isn't "arithmetic" — there's nothing to compute)
  if (!/\d/.test(cleaned)) return false;
  if (!/[+\-*/%^]/.test(cleaned)) return false;
  return MATH_EXPR.test(cleaned);
}

/**
 * Given one side of a relation that may carry leading/trailing prose
 * ("The total is 2 + 2" → "2 + 2"), extract the contiguous math expression
 * adjacent to the operator. For lhs we keep the TRAILING math run; for rhs the
 * LEADING one. Returns the original string if no math run is found (the caller's
 * looksLikeMathExpr guard then rejects it).
 */
function extractMathSide(side: string, which: 'lhs' | 'rhs'): string {
  const normalized = side.replace(/\bpercent\b/gi, '%').replace(/\bof\b/gi, ' of ');
  // A math run: numbers/operators/parens/%/of, possibly space-separated.
  const runRe = /(?:\d[\d.,]*|[-+*/()^%]|\bof\b)(?:\s*(?:\d[\d.,]*|[-+*/()^%]|\bof\b))*/gi;
  const runs = normalized.match(runRe);
  if (!runs || runs.length === 0) return side;
  const picked = which === 'lhs' ? runs[runs.length - 1]! : runs[0]!;
  return picked.trim();
}

function recognizeArithmetic(content: string): TypedClaim | null {
  const m = matchArithRelation(content);
  if (!m) return null;
  // Strip trailing prose/punctuation off both sides; keep only the math-relevant tail/head.
  const lhs = extractMathSide((m[1] ?? '').trim(), 'lhs');
  const op = (m[2] ?? '').trim().toLowerCase();
  const rhs = extractMathSide((m[3] ?? '').trim().replace(/[.!?]+$/, ''), 'rhs');
  // Both sides must look like math for this to be a checkable arithmetic claim.
  // (At least one side must be a compound expression, else it's a bare
  //  number identity like "x is 5" which we don't execute.)
  if (!looksLikeMathExpr(lhs) && !looksLikeMathExpr(rhs)) return null;
  if (!/\d/.test(lhs) || !/\d/.test(rhs)) return null;
  const relation = normalizeRelation(op);
  if (!relation) return null;
  return {
    content,
    type: 'executable',
    executableKind: 'arithmetic',
    checkability: 1.0,
    parsed: { lhs, rhs, relation },
  };
}

export type Relation = 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' | 'approx';

function normalizeRelation(op: string): Relation | null {
  switch (op) {
    case '=':
    case '==':
    case 'equals':
    case 'is equal to':
    case 'is':
      return 'eq';
    case '≠':
    case '!=':
      return 'neq';
    case '<':
      return 'lt';
    case '<=':
      return 'lte';
    case '>':
      return 'gt';
    case '>=':
      return 'gte';
    case '≈':
    case 'approximately':
      return 'approx';
    default:
      return null;
  }
}

/** EVM address (0x + 40 hex) or 66-char tx hash (0x + 64 hex). */
const EVM_ADDRESS = /\b0x[0-9a-fA-F]{40}\b/;
const EVM_TXHASH = /\b0x[0-9a-fA-F]{64}\b/;

function recognizeOnchain(content: string): TypedClaim | null {
  const tx = content.match(EVM_TXHASH);
  if (tx) {
    return {
      content,
      type: 'executable',
      executableKind: 'onchain',
      checkability: 1.0,
      parsed: { kind: 'tx', txHash: tx[0] },
    };
  }
  const addr = content.match(EVM_ADDRESS);
  if (addr) {
    // Heuristic sub-kind: "balance" if the sentence talks about balance/holds/wei/eth.
    const balanceish = /\b(balance|holds?|has|wei|eth|ether|gwei)\b/i.test(content);
    return {
      content,
      type: 'executable',
      executableKind: 'onchain',
      checkability: 1.0,
      parsed: { kind: balanceish ? 'balance' : 'code', address: addr[0] },
    };
  }
  return null;
}

/** A citation we could resolve: DOI, arXiv id, or a bare URL. */
const DOI = /\b10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+\b/;
const ARXIV = /\barXiv:\s*\d{4}\.\d{4,5}(v\d+)?\b/i;
const URL = /\bhttps?:\/\/[^\s)]+/i;

function recognizeCitation(content: string): TypedClaim | null {
  const doi = content.match(DOI);
  const arxiv = content.match(ARXIV);
  const url = content.match(URL);
  if (!doi && !arxiv && !url) return null;
  return {
    content,
    type: 'source-grounded',
    // A resolvable citation is executable-in-principle (fetch + check), but we
    // do NOT do network fetches in the floor, so its checkability sits at the
    // source-grounded tier, not the deterministic 1.0 tier.
    checkability: 0.4,
    parsed: {
      ...(doi ? { doi: doi[0] } : {}),
      ...(arxiv ? { arxiv: arxiv[0] } : {}),
      ...(url ? { url: url[0] } : {}),
    },
  };
}

/**
 * Code claim: talks about a symbol/function/return/compile/type. We recognize
 * it so the floor can mark it "executable-but-not-run" (the law forbids
 * arbitrary code exec in this module — honesty over faked execution).
 */
const CODE_MARKERS =
  /\b(compiles?|returns?|throws?|function\s+\w+|const\s+\w+|type\s+\w+|passes?\s+the\s+tests?|`[^`]+`|def\s+\w+|class\s+\w+)\b/i;

function recognizeCode(content: string): TypedClaim | null {
  if (!CODE_MARKERS.test(content)) return null;
  return {
    content,
    type: 'executable',
    executableKind: 'code',
    // executable-in-principle but NOT run here (see execution-floor law) → 0.6
    checkability: 0.6,
    parsed: { runnable: false, reason: 'code execution disabled (unsafe) — marked executable-but-not-run' },
  };
}

/**
 * DB-answerable claim: references a known repid-engine entity that a scoped
 * read could answer (an agent's RepID, tier, a score-event count). Recognized
 * so the floor can wire a scoped read; left as a stub sub-kind here.
 */
const DB_MARKERS =
  /\b(repid|rep\s?id|tier|score[_\s]?event|agent(?:'s)?\s+(?:reputation|standing|rank)|current_repid)\b/i;
const DB_NUMBER = /\b\d[\d,]*\b/;

function recognizeDb(content: string): TypedClaim | null {
  if (!DB_MARKERS.test(content)) return null;
  // Only a *checkable* DB claim if it asserts a concrete value/count.
  if (!DB_NUMBER.test(content)) return null;
  return {
    content,
    type: 'executable',
    executableKind: 'db',
    checkability: 0.6, // wired path is a scoped read; stubbed until enabled
    parsed: { runnable: false, reason: 'db checker present but scoped-read not enabled in shadow mode' },
  };
}

// --------------------------------------------------------------------------
// Probabilistic / unverifiable fallbacks.
// --------------------------------------------------------------------------

const FUTURE_MARKERS =
  /\b(will|would|going to|by\s+20\d\d|next\s+(?:year|month|week|quarter)|forecast|predict|expect|likely|probably|projected?)\b/i;

const OPINION_MARKERS =
  /\b(beautiful|elegant|ugly|best|worst|better|should|ought|prefer|feels?|seems?|i think|in my opinion|arguably)\b/i;

function classifyNonExecutable(content: string): TypedClaim {
  if (FUTURE_MARKERS.test(content)) {
    return { content, type: 'probabilistic', checkability: 0.1 };
  }
  if (OPINION_MARKERS.test(content)) {
    return { content, type: 'unverifiable', checkability: 0.0 };
  }
  // A declarative factual sentence with no local checker and no citation is
  // treated as source-grounded-in-principle (a fact that WOULD need an external
  // source to verify). It falls through to HAL untouched by the floor.
  return { content, type: 'source-grounded', checkability: 0.4 };
}

// Ordered executable recognizers — first match wins.
const EXECUTABLE_RECOGNIZERS: Array<(c: string) => TypedClaim | null> = [
  recognizeArithmetic,
  recognizeOnchain,
  recognizeDb,
  recognizeCode,
];

/** Type a single atomic claim. Deterministic; never throws. */
export function typeClaim(content: string): TypedClaim {
  const trimmed = content.trim();
  if (!trimmed) return { content, type: 'unverifiable', checkability: 0.0 };

  for (const recognize of EXECUTABLE_RECOGNIZERS) {
    const hit = recognize(trimmed);
    if (hit) return hit;
  }
  // Citations are source-grounded (checked before the generic fallback).
  const cite = recognizeCitation(trimmed);
  if (cite) return cite;

  return classifyNonExecutable(trimmed);
}

/**
 * Extract + type all atomic claims from an output.
 * The public entry point for the claim-typing half of the floor.
 */
export function extractTypedClaims(output: string): TypedClaim[] {
  return segmentClaims(output).map(typeClaim);
}
