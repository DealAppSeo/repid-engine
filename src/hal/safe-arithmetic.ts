/**
 * Safe arithmetic evaluator — a tiny recursive-descent parser for the
 * execution floor's `arithmetic` checker.
 *
 * WHY NOT eval(): the floor's whole promise is trustworthiness. `eval` / `Function`
 * on model output is a code-execution sink and is categorically forbidden here
 * (Sprint discipline: no arbitrary code exec). This parser accepts ONLY a
 * numeric grammar — numbers, + - * / , parentheses, unary minus, exponent (^),
 * and percent (n% → n/100). Anything outside the grammar throws; there is no
 * path from input text to code execution.
 *
 * Grammar (standard precedence):
 *   expr    := term (('+' | '-') term)*
 *   term    := factor (('*' | '/') factor)*
 *   factor  := unary ('^' unary)*        // right-assoc handled in parseFactor
 *   unary   := ('+' | '-') unary | postfix
 *   postfix := primary ('%')*            // trailing percent
 *   primary := number | '(' expr ')'
 *
 * Dependency-free. Pure. Never touches I/O.
 */

export interface ArithEvalResult {
  ok: boolean;
  value?: number;
  error?: string;
}

/** Tokenize a math string. Returns null on an illegal character. */
function tokenize(input: string): string[] | null {
  const tokens: string[] = [];
  let i = 0;
  const s = input;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    if (ch === ',') {
      // thousands separator — skip (only valid between digits, but we're lenient)
      i++;
      continue;
    }
    if ('+-*/^()%'.includes(ch)) {
      tokens.push(ch);
      i++;
      continue;
    }
    // number: digits with optional single decimal point
    if (ch >= '0' && ch <= '9') {
      let num = '';
      let sawDot = false;
      while (i < s.length) {
        const c = s[i]!;
        if (c >= '0' && c <= '9') {
          num += c;
          i++;
        } else if (c === '.' && !sawDot) {
          sawDot = true;
          num += c;
          i++;
        } else if (c === ',') {
          i++; // skip thousands sep inside a number
        } else {
          break;
        }
      }
      tokens.push(num);
      continue;
    }
    if (ch === '.') {
      // leading-dot number like ".5"
      let num = '.';
      i++;
      while (i < s.length && s[i]! >= '0' && s[i]! <= '9') {
        num += s[i]!;
        i++;
      }
      if (num === '.') return null;
      tokens.push(num);
      continue;
    }
    return null; // illegal character
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: string[]) {}

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }
  private next(): string | undefined {
    return this.tokens[this.pos++];
  }
  private eof(): boolean {
    return this.pos >= this.tokens.length;
  }

  parse(): number {
    const v = this.parseExpr();
    if (!this.eof()) throw new Error(`unexpected token "${this.peek()}"`);
    return v;
  }

  private parseExpr(): number {
    let v = this.parseTerm();
    while (this.peek() === '+' || this.peek() === '-') {
      const op = this.next();
      const rhs = this.parseTerm();
      v = op === '+' ? v + rhs : v - rhs;
    }
    return v;
  }

  private parseTerm(): number {
    let v = this.parseFactor();
    while (this.peek() === '*' || this.peek() === '/') {
      const op = this.next();
      const rhs = this.parseFactor();
      if (op === '/') {
        if (rhs === 0) throw new Error('division by zero');
        v = v / rhs;
      } else {
        v = v * rhs;
      }
    }
    return v;
  }

  // exponent is right-associative
  private parseFactor(): number {
    const base = this.parseUnary();
    if (this.peek() === '^') {
      this.next();
      const exp = this.parseFactor();
      return Math.pow(base, exp);
    }
    return base;
  }

  private parseUnary(): number {
    if (this.peek() === '+') {
      this.next();
      return this.parseUnary();
    }
    if (this.peek() === '-') {
      this.next();
      return -this.parseUnary();
    }
    return this.parsePostfix();
  }

  private parsePostfix(): number {
    let v = this.parsePrimary();
    while (this.peek() === '%') {
      this.next();
      v = v / 100;
    }
    return v;
  }

  private parsePrimary(): number {
    const t = this.peek();
    if (t === '(') {
      this.next();
      const v = this.parseExpr();
      if (this.next() !== ')') throw new Error('missing closing parenthesis');
      return v;
    }
    if (t === undefined) throw new Error('unexpected end of expression');
    const n = Number(t);
    if (!Number.isFinite(n)) throw new Error(`not a number: "${t}"`);
    this.next();
    return n;
  }
}

/**
 * Evaluate a math expression string safely. Recognizes "percent" and "of"
 * are normalized by the CALLER (claim-typing) before this is invoked; here we
 * accept only the pure numeric grammar. Returns { ok:false } (never throws)
 * for any malformed / out-of-grammar input.
 */
export function safeEvalArithmetic(expr: string): ArithEvalResult {
  const prepared = prepare(expr);
  if ('error' in prepared) return { ok: false, error: prepared.error };
  try {
    const value = new Parser(prepared.tokens).parse();
    if (!Number.isFinite(value)) {
      return { ok: false, error: 'non-finite result' };
    }
    return { ok: true, value };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Normalize word forms and tokenize. ONE copy, shared by the float evaluator above and the exact
 * evaluator below, so the two cannot drift into accepting different strings.
 */
function prepare(expr: string): { tokens: string[] } | { error: string } {
  if (typeof expr !== 'string' || expr.trim().length === 0) {
    return { error: 'empty expression' };
  }
  // Normalize word forms the recognizer may pass through.
  const normalized = expr
    .replace(/\bpercent\b/gi, '%')
    .replace(/\bof\b/gi, '*')
    .replace(/×/g, '*')
    .replace(/÷/g, '/');
  const tokens = tokenize(normalized);
  if (tokens === null) {
    return { error: 'expression contains non-numeric characters' };
  }
  if (tokens.length === 0) {
    return { error: 'no tokens' };
  }
  return { tokens };
}

/* -------------------------------------------------------------------------------------------------
 * EXACT evaluation.
 *
 * `safeEvalArithmetic` returns a double. Two numbers a double cannot tell apart compare equal, and a
 * tolerance on top of that grows with the magnitude, so a caller that must decide "is this equation
 * TRUE" cannot use it past ~10^9 (src/routes/classify.ts was doing exactly that; XC1 red team).
 * This evaluates the SAME grammar over BigInt rationals, so every sum, difference, product, quotient
 * and integer power is exact and there is no residue to tolerate. `0.1 + 0.2` is exactly `3/10`.
 *
 * It refuses, and says why, rather than approximating: a non-integer exponent is not a rational
 * (`2 ^ 0.5`), division by zero is undefined, and a result past MAX_EXACT_BITS is refused so a power
 * tower like `9 ^ 9 ^ 9 ^ 9` cannot ask BigInt for gigabytes. The caller then falls back to the float
 * evaluator for what exact arithmetic does not cover. It never returns a rounded answer.
 * ----------------------------------------------------------------------------------------------- */

/** value = num / den, den > 0, gcd(|num|, den) = 1. */
export interface ExactRational {
  num: bigint;
  den: bigint;
}

export interface ExactEvalResult {
  ok: boolean;
  value?: ExactRational;
  error?: string;
}

/** Largest numerator-plus-denominator size, in bits, an intermediate or final value may have. */
const MAX_EXACT_BITS = 8192;
/** A literal longer than this is refused; a claim of this size is not a calculation anyone checks. */
const MAX_LITERAL_DIGITS = 1000;

function bitLength(x: bigint): number {
  return (x < 0n ? -x : x).toString(2).length;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/** Reduce, force den > 0, and refuse anything past the size bound. */
function rational(num: bigint, den: bigint): ExactRational {
  if (den === 0n) throw new Error('division by zero');
  const g = gcd(num, den);
  let n = num / g;
  let d = den / g;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  if (bitLength(n) + bitLength(d) > MAX_EXACT_BITS) throw new Error('result too large for exact arithmetic');
  return { num: n, den: d };
}

class ExactParser {
  private pos = 0;
  constructor(private readonly tokens: string[]) {}

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }
  private next(): string | undefined {
    return this.tokens[this.pos++];
  }

  parse(): ExactRational {
    const v = this.parseExpr();
    if (this.pos < this.tokens.length) throw new Error(`unexpected token "${this.peek()}"`);
    return v;
  }

  private parseExpr(): ExactRational {
    let v = this.parseTerm();
    while (this.peek() === '+' || this.peek() === '-') {
      const op = this.next();
      const r = this.parseTerm();
      v = op === '+' ? rational(v.num * r.den + r.num * v.den, v.den * r.den) : rational(v.num * r.den - r.num * v.den, v.den * r.den);
    }
    return v;
  }

  private parseTerm(): ExactRational {
    let v = this.parseFactor();
    while (this.peek() === '*' || this.peek() === '/') {
      const op = this.next();
      const r = this.parseFactor();
      if (op === '/') {
        if (r.num === 0n) throw new Error('division by zero');
        v = rational(v.num * r.den, v.den * r.num);
      } else {
        v = rational(v.num * r.num, v.den * r.den);
      }
    }
    return v;
  }

  // exponent is right-associative, as in the float parser
  private parseFactor(): ExactRational {
    const base = this.parseUnary();
    if (this.peek() === '^') {
      this.next();
      return this.power(base, this.parseFactor());
    }
    return base;
  }

  private power(base: ExactRational, exp: ExactRational): ExactRational {
    if (exp.den !== 1n) throw new Error('non-integer exponent is not exact');
    const e = exp.num;
    const mag = e < 0n ? -e : e;
    if (base.num === 0n) {
      if (e < 0n) throw new Error('division by zero');
      return e === 0n ? { num: 1n, den: 1n } : { num: 0n, den: 1n };
    }
    // Refuse BEFORE computing: BigInt ** would happily try to build a number of gigabytes.
    if (mag * BigInt(bitLength(base.num) + bitLength(base.den)) > BigInt(MAX_EXACT_BITS)) {
      throw new Error('result too large for exact arithmetic');
    }
    const n = base.num ** mag;
    const d = base.den ** mag;
    return e < 0n ? rational(d, n) : rational(n, d);
  }

  private parseUnary(): ExactRational {
    if (this.peek() === '+') {
      this.next();
      return this.parseUnary();
    }
    if (this.peek() === '-') {
      this.next();
      const v = this.parseUnary();
      return { num: -v.num, den: v.den };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): ExactRational {
    let v = this.parsePrimary();
    while (this.peek() === '%') {
      this.next();
      v = rational(v.num, v.den * 100n);
    }
    return v;
  }

  private parsePrimary(): ExactRational {
    const t = this.peek();
    if (t === '(') {
      this.next();
      const v = this.parseExpr();
      if (this.next() !== ')') throw new Error('missing closing parenthesis');
      return v;
    }
    if (t === undefined) throw new Error('unexpected end of expression');
    // The tokenizer only emits digits with at most one '.', so a decimal is digits/10^places exactly.
    const [whole = '', frac = ''] = t.split('.');
    const digits = whole + frac;
    if (!/^\d+$/.test(digits)) throw new Error(`not a number: "${t}"`);
    if (digits.length > MAX_LITERAL_DIGITS) throw new Error('number too long for exact arithmetic');
    this.next();
    return rational(BigInt(digits), 10n ** BigInt(frac.length));
  }
}

/**
 * Evaluate the same grammar as `safeEvalArithmetic`, exactly, as a reduced rational. Never throws.
 * `ok: false` means "not decidable exactly" (see the block comment), not "false".
 */
export function safeEvalExact(expr: string): ExactEvalResult {
  const prepared = prepare(expr);
  if ('error' in prepared) return { ok: false, error: prepared.error };
  try {
    return { ok: true, value: new ExactParser(prepared.tokens).parse() };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
