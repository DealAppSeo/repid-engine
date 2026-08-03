/**
 * The OpenAI-compatible surface — drop-in means drop-in.
 *
 * Our broker takes `{ prompt }`. Every tool in the ecosystem speaks
 * `{ model, messages }` — Odysseus (84.6k stars), Open WebUI, Cursor, Continue,
 * LangChain, LiteLLM, the official SDKs. None could point at us. That was a
 * one-adapter problem standing in front of the whole trust layer.
 *
 * These tests defend the two things that make it actually drop-in:
 *   1. the response body is EXACTLY OpenAI's shape, extras ride in headers
 *   2. a role is never silently flattened away, because HAL would then be scoring
 *      an answer to a prompt that never existed
 */

import {
  flattenMessages,
  verdictOf,
  resolveFamilyOrUnverified,
} from '../src/routes/v1/openai-compat';

describe('message flattening keeps roles distinguishable', () => {
  it('separates system from the conversation', () => {
    const r = flattenMessages([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'Hello' },
    ]);
    expect(r.system).toBe('You are terse.');
    expect(r.prompt).toBe('User: Hello');
  });

  it('labels who said what — a system instruction must not read as user text', () => {
    // A model given a system instruction as if the user typed it behaves
    // differently, and then HAL scores an answer to a prompt nobody sent.
    const r = flattenMessages([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ]);
    expect(r.prompt).toBe('User: first\n\nAssistant: reply\n\nUser: second');
    expect(r.system).toBeNull();
  });

  it('joins multiple system messages rather than dropping any', () => {
    const r = flattenMessages([
      { role: 'system', content: 'a' },
      { role: 'system', content: 'b' },
      { role: 'user', content: 'q' },
    ]);
    expect(r.system).toBe('a\n\nb');
  });

  it('treats an unknown role as user rather than discarding the content', () => {
    const r = flattenMessages([{ role: 'tool', content: 'payload' }]);
    expect(r.prompt).toContain('payload');
  });

  it('survives null/undefined content without emitting "undefined"', () => {
    const r = flattenMessages([{ role: 'user', content: undefined as any }]);
    expect(r.prompt).not.toMatch(/undefined/);
  });

  it('returns an empty prompt when there is nothing but a system message', () => {
    const r = flattenMessages([{ role: 'system', content: 'only rules' }]);
    expect(r.prompt).toBe('');
    expect(r.system).toBe('only rules');
  });
});

describe('verdict vocabulary is honest about not knowing', () => {
  it("reports 'unscored' when scoring did not happen", () => {
    expect(verdictOf('clean', false)).toBe('unscored');
    expect(verdictOf(null, false)).toBe('unscored');
  });

  it('maps the real decisions through', () => {
    expect(verdictOf('clean', true)).toBe('clean');
    expect(verdictOf('flagged', true)).toBe('flagged');
    expect(verdictOf('vetoed', true)).toBe('vetoed');
    expect(verdictOf('veto', true)).toBe('vetoed');
  });

  it("falls back to 'unscored' for a decision it does not recognise, never to 'clean'", () => {
    // Guessing 'clean' from an unknown verdict is the one wrong answer here.
    expect(verdictOf('something-new', true)).toBe('unscored');
    expect(verdictOf('', true)).toBe('unscored');
  });
});

describe('family resolution never guesses', () => {
  it("returns 'unverified' for an unregistered model rather than inventing a family", () => {
    // resolveFamily throws by design (register-first). An unknown model must not be
    // counted toward quorum diversity.
    expect(resolveFamilyOrUnverified('totally-made-up-model-9000', 'nobody')).toBe('unverified');
  });

  it('does NOT fall back to the provider name — that lookup can never succeed', () => {
    // The registry is keyed by MODEL (BY_MODEL), so 'groq' is not a key. My first
    // version tried it as a fallback; this test proved the branch was dead, and a
    // fallback that cannot fire reads as safety while adding none. Removed.
    expect(resolveFamilyOrUnverified('unregistered-xyz', 'groq')).toBe('unverified');
  });

  it('resolves a known model', () => {
    expect(resolveFamilyOrUnverified('llama-3.1-8b-instant', 'groq')).not.toBe('unverified');
  });

  it("skips the literal 'unknown' placeholder rather than trying to resolve it", () => {
    expect(resolveFamilyOrUnverified('unknown', 'unknown')).toBe('unverified');
  });

  it('never throws, whatever it is handed', () => {
    for (const [m, p] of [['', ''], [null as any, undefined as any], ['{}', '[]']]) {
      expect(() => resolveFamilyOrUnverified(m, p)).not.toThrow();
    }
  });
});
