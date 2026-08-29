/**
 * ILIKE TREATS `_` AND `%` AS WILDCARDS, AND EMAIL LOOKUPS PASSED CALLER TEXT STRAIGHT INTO ONE.
 *
 * `findExisting()` resolves "does an account already exist for this verified email" with
 * `.ilike('email', email)`, and hands the matched row's id to the token minter. `_` matches any
 * single character in ILIKE and `%` matches any sequence — so an attacker who verifies an inbox
 * whose address contains one of those characters gets a PATTERN matched against every stored
 * email, and the first row it hits is the account they are logged into.
 *
 * This is not a query-injection escape (PostgREST parameterises the value); it is the pattern
 * language of the operator being handed to the caller. The direction of failure is what makes it
 * matter: it fails OPEN, onto someone else's account, and the email branch is checked FIRST so a
 * wildcard hit beats the victim's own exact address.
 *
 * These tests drive the escaping helper directly. They do not need a database, because the
 * question is entirely about what pattern is built from the caller's text.
 */
import { likeLiteral } from '../src/utils/like-literal';

/** Faithful ILIKE semantics for the two metacharacters, plus backslash escapes. */
function ilikeMatches(pattern: string, subject: string): boolean {
  let rx = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      const next = pattern[i + 1];
      if (next !== undefined) { rx += next.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); i++; continue; }
      rx += '\\\\'; continue;
    }
    if (ch === '%') { rx += '.*'; continue; }
    if (ch === '_') { rx += '.'; continue; }
    rx += (ch as string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${rx}$`, 'i').test(subject);
}

describe('ilikeMatches — the model of the operator itself', () => {
  it('is a faithful model: bare _ and % really do match', () => {
    expect(ilikeMatches('bob_smith@corp.com', 'bobXsmith@corp.com')).toBe(true);
    expect(ilikeMatches('a%@corp.com', 'anything@corp.com')).toBe(true);
    expect(ilikeMatches('bob.smith@corp.com', 'bobXsmith@corp.com')).toBe(false);
  });
});

describe('likeLiteral — the escape that closes it', () => {
  it('an underscore no longer matches an arbitrary character', () => {
    const attacker = 'bob_smith@corp.com';
    const victim = 'bobXsmith@corp.com';
    expect(ilikeMatches(attacker, victim)).toBe(true);              // the hole
    expect(ilikeMatches(likeLiteral(attacker), victim)).toBe(false); // closed
  });

  it('a percent no longer matches an arbitrary sequence', () => {
    const attacker = 'a%@corp.com';
    expect(ilikeMatches(attacker, 'anything@corp.com')).toBe(true);
    expect(ilikeMatches(likeLiteral(attacker), 'anything@corp.com')).toBe(false);
  });

  it('a single % does not become a match-everything pattern', () => {
    expect(ilikeMatches('%', 'literally-any-account@corp.com')).toBe(true);
    expect(ilikeMatches(likeLiteral('%'), 'literally-any-account@corp.com')).toBe(false);
  });

  it('the address STILL matches ITSELF — escaping must not break the real lookup', () => {
    for (const e of ['bob_smith@corp.com', 'a%@corp.com', 'plain@corp.com', 'a\\b@corp.com']) {
      expect(ilikeMatches(likeLiteral(e), e)).toBe(true);
    }
  });

  it('case-insensitivity is preserved — that is why this stays ILIKE and does not become eq', () => {
    expect(ilikeMatches(likeLiteral('bob_smith@corp.com'), 'BOB_SMITH@CORP.COM')).toBe(true);
  });

  it('a backslash is escaped rather than eating the character after it', () => {
    expect(ilikeMatches(likeLiteral('a\\_b@corp.com'), 'aX_b@corp.com')).toBe(false);
    expect(ilikeMatches(likeLiteral('a\\_b@corp.com'), 'a\\_b@corp.com')).toBe(true);
  });
});
