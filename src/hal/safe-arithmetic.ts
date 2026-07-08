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
  if (typeof expr !== 'string' || expr.trim().length === 0) {
    return { ok: false, error: 'empty expression' };
  }
  // Normalize word forms the recognizer may pass through.
  const normalized = expr
    .replace(/\bpercent\b/gi, '%')
    .replace(/\bof\b/gi, '*')
    .replace(/×/g, '*')
    .replace(/÷/g, '/');
  const tokens = tokenize(normalized);
  if (tokens === null) {
    return { ok: false, error: 'expression contains non-numeric characters' };
  }
  if (tokens.length === 0) {
    return { ok: false, error: 'no tokens' };
  }
  try {
    const value = new Parser(tokens).parse();
    if (!Number.isFinite(value)) {
      return { ok: false, error: 'non-finite result' };
    }
    return { ok: true, value };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
