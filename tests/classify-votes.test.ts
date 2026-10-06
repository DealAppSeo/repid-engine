/**
 * The `votes` field of POST /api/v1/classify (2026-10-06): each decider's own word, names and
 * verdict words only, always consistent with the label. An out-of-contract `votes` is dropped and
 * the label kept.
 */
import { classifyWithDeadline, votesOf, type Classifier } from '../src/routes/classify';

const D = ['groq', 'cerebras'];
const v = (verdict: string, voter = 'groq', family = 'gpt-oss') => ({ voter, family, verdict });

describe('votesOf', () => {
  it('a pass is two TRUE, a veto two FALSE', () => {
    expect(votesOf([v('TRUE'), v('TRUE', 'cerebras', 'qwen')], D, 'pass')).toHaveLength(2);
    expect(votesOf([v('FALSE'), v('FALSE', 'cerebras', 'qwen')], D, 'veto')).toHaveLength(2);
  });

  it('not-checked is anything else: a disagreement, an unsure, no answer', () => {
    expect(votesOf([v('TRUE'), v('FALSE', 'cerebras', 'qwen')], D, 'not-checked')).not.toBeNull();
    expect(votesOf([v('UNSURE'), v('TRUE', 'cerebras', 'qwen')], D, 'not-checked')).not.toBeNull();
    expect(votesOf([v('NONE'), v('FALSE', 'cerebras', 'qwen')], D, 'not-checked')).not.toBeNull();
  });

  it('votes that contradict the label are dropped, never used to change it', () => {
    expect(votesOf([v('TRUE'), v('FALSE', 'cerebras', 'qwen')], D, 'pass')).toBeNull();
    expect(votesOf([v('TRUE'), v('TRUE', 'cerebras', 'qwen')], D, 'not-checked')).toBeNull();
    expect(votesOf([v('FALSE'), v('FALSE', 'cerebras', 'qwen')], D, 'pass')).toBeNull();
  });

  it('exactly the two deciders, in order, with a plain family and a known verdict word', () => {
    expect(votesOf([v('TRUE', 'cerebras', 'qwen'), v('TRUE')], D, 'pass')).toBeNull(); // order
    expect(votesOf([v('TRUE')], D, 'pass')).toBeNull(); // one
    expect(votesOf([v('TRUE'), v('TRUE', 'cerebras', 'Qwen Prose!')], D, 'pass')).toBeNull();
    expect(votesOf([v('TRUE'), v('yes', 'cerebras', 'qwen')], D, 'pass')).toBeNull();
    expect(votesOf('TRUE,TRUE', D, 'pass')).toBeNull();
  });
});

describe('the route passes votes through, or drops them', () => {
  const run = (answer: unknown) => classifyWithDeadline('x', (() => answer) as Classifier, 1000);

  it('kept beside deciders', async () => {
    const out = await run({ label: 'veto', by: 'votes', voters: D, deciders: D, votes: [v('FALSE'), v('FALSE', 'cerebras', 'qwen')] });
    expect(out.votes).toEqual([v('FALSE'), v('FALSE', 'cerebras', 'qwen')]);
  });

  it('dropped without deciders, and dropped when they contradict the label; the label stands', async () => {
    const noDeciders = await run({ label: 'veto', by: 'votes', voters: D, votes: [v('FALSE'), v('FALSE', 'cerebras', 'qwen')] });
    expect(noDeciders).toMatchObject({ label: 'veto' });
    expect(noDeciders.votes).toBeUndefined();
    const lying = await run({ label: 'pass', by: 'votes', voters: D, deciders: D, votes: [v('FALSE'), v('FALSE', 'cerebras', 'qwen')] });
    expect(lying).toMatchObject({ label: 'pass', deciders: D });
    expect(lying.votes).toBeUndefined();
  });
});
