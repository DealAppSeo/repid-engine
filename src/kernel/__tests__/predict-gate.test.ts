/**
 * predict-gate.test.ts — proves WHEN a prediction fires (strategy §v0.2.15):
 * consequential OR sample OR LAO-fired, and that Laya is SHADOW ONLY — it never votes.
 */
import {
  shouldPredict,
  isConsequential,
  envSampler,
  type PredictAction,
  type PredictGateDeps,
} from '../predict-gate';
import type { LayaClassification } from '../../laya/classify';

const laya = (route: LayaClassification['route']): LayaClassification => ({
  route,
  latency_ms: 0,
  reuse: route === 'cheap' ? 'postcard' : null,
  postcard: route === 'cheap' ? 'deadbeef' : null,
});

const alwaysSample: PredictGateDeps = { sample: () => true };
const neverSample: PredictGateDeps = { sample: () => false };

// ════════════════════════════════════════════════════════════════════════════════════════
describe('the structural "consequential" verdict (deterministic, not an opinion)', () => {
  it('spend and post leave the machine ⇒ consequential', () => {
    expect(isConsequential({ toolClass: 'spend' })).toBe(true);
    expect(isConsequential({ toolClass: 'post' })).toBe(true);
  });

  it('read and other are not consequential by themselves', () => {
    expect(isConsequential({ toolClass: 'read' })).toBe(false);
    expect(isConsequential({ toolClass: 'other' })).toBe(false);
  });

  it('an explicit leavesMachine flag makes a read/other consequential (a write/egress tool)', () => {
    expect(isConsequential({ toolClass: 'read', leavesMachine: true })).toBe(true);
    expect(isConsequential({ toolClass: 'other', leavesMachine: true })).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('the three triggers, OR\'d', () => {
  it('a plain read with no sample and no LAO does NOT predict', () => {
    const r = shouldPredict({ toolClass: 'read' }, neverSample);
    expect(r.predict).toBe(false);
    expect(r.triggers).toEqual([]);
    expect(r.consequential).toBe(false);
  });

  it('a consequential action predicts on the consequential trigger', () => {
    const r = shouldPredict({ toolClass: 'spend' }, neverSample);
    expect(r.predict).toBe(true);
    expect(r.triggers).toEqual(['consequential']);
  });

  it('a non-consequential action predicts when the sample fires', () => {
    const r = shouldPredict({ toolClass: 'read' }, alwaysSample);
    expect(r.predict).toBe(true);
    expect(r.triggers).toEqual(['sample']);
    expect(r.consequential).toBe(false);
  });

  it('a non-consequential action predicts when LAO has already fired', () => {
    const r = shouldPredict({ toolClass: 'read', laoFired: true }, neverSample);
    expect(r.predict).toBe(true);
    expect(r.triggers).toEqual(['lao_fired']);
  });

  it('all three can fire together, recorded in priority order', () => {
    const r = shouldPredict({ toolClass: 'spend', laoFired: true }, alwaysSample);
    expect(r.predict).toBe(true);
    expect(r.triggers).toEqual(['consequential', 'sample', 'lao_fired']);
  });

  it('absent sampler ⇒ the sample trigger is simply off (consequential still fires)', () => {
    expect(shouldPredict({ toolClass: 'read' }).predict).toBe(false);
    expect(shouldPredict({ toolClass: 'spend' }).triggers).toEqual(['consequential']);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('LAYA IS SHADOW ONLY — it never votes on the decision', () => {
  it("an 'escalate' Laya route cannot by itself cause a prediction", () => {
    // A read with no sample / no LAO, but text Laya would escalate (contains 'proof').
    const r = shouldPredict(
      { toolClass: 'read', text: 'please verify the proof here' },
      { ...neverSample, layaClassify: () => laya('escalate') },
    );
    expect(r.predict).toBe(false); // Laya's escalate did NOT earn a prediction
    expect(r.shadow.layaRoute).toBe('escalate');
    expect(r.shadow.layaSaysConsequential).toBe(true);
    expect(r.shadow.agreesWithVerdict).toBe(false); // Laya says yes, structure says no
  });

  it("a 'cheap' Laya route cannot suppress a structurally consequential action", () => {
    const r = shouldPredict(
      { toolClass: 'spend', text: 'ok' },
      { ...neverSample, layaClassify: () => laya('cheap') },
    );
    expect(r.predict).toBe(true); // Laya's cheap did NOT suppress the spend
    expect(r.triggers).toEqual(['consequential']);
    expect(r.shadow.layaRoute).toBe('cheap');
    expect(r.shadow.layaSaysConsequential).toBe(false);
    expect(r.shadow.agreesWithVerdict).toBe(false); // Laya says no, structure says yes
  });

  it('records agreement when Laya and the structural verdict coincide', () => {
    const r = shouldPredict(
      { toolClass: 'spend', text: 'settle the contract and stake' },
      { ...neverSample, layaClassify: () => laya('escalate') },
    );
    expect(r.shadow.layaSaysConsequential).toBe(true);
    expect(r.shadow.agreesWithVerdict).toBe(true);
  });

  it('no text ⇒ the shadow block is all null, and the decision is unchanged', () => {
    const r = shouldPredict({ toolClass: 'spend' }, neverSample);
    expect(r.shadow).toEqual({ layaRoute: null, layaSaysConsequential: null, agreesWithVerdict: null });
    expect(r.predict).toBe(true);
  });

  it('a Laya that throws cannot affect the decision (shadow stays null)', () => {
    const r = shouldPredict(
      { toolClass: 'read', text: 'x', laoFired: true },
      {
        ...neverSample,
        layaClassify: () => {
          throw new Error('classifier down');
        },
      },
    );
    expect(r.predict).toBe(true); // LAO fired — unaffected by the shadow failure
    expect(r.triggers).toEqual(['lao_fired']);
    expect(r.shadow.layaRoute).toBeNull();
  });

  it('uses the real local Laya classifier when none is injected (still shadow only)', () => {
    // 'proof' is a HEAVY keyword ⇒ real classify routes 'escalate'; still must not vote.
    const r = shouldPredict({ toolClass: 'read', text: 'a proof' }, neverSample);
    expect(r.shadow.layaRoute).toBe('escalate');
    expect(r.predict).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('never on the hot path: the gate is pure and synchronous', () => {
  it('returns a plain result, not a promise', () => {
    const r = shouldPredict({ toolClass: 'read' }, neverSample);
    expect(typeof (r as unknown as { then?: unknown }).then).toBe('undefined');
    expect(typeof r.predict).toBe('boolean');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('envSampler: fail-closed, env-sourced rate (the 1-in-N canary)', () => {
  const SAVED = { ...process.env };
  afterEach(() => {
    for (const k of ['REPID_PREDICT_SAMPLE_RATE', 'NODE_ENV']) delete process.env[k];
    for (const [k, v] of Object.entries(SAVED)) if (v !== undefined) process.env[k] = v;
  });

  it('a rate of 0 ⇒ sampling off', () => {
    const s = envSampler({ REPID_PREDICT_SAMPLE_RATE: '0' } as NodeJS.ProcessEnv, () => 0);
    expect(s()).toBe(false);
  });

  it('unset in PRODUCTION ⇒ sampling off (fail closed, never a guessed rate)', () => {
    const s = envSampler({ NODE_ENV: 'production' } as NodeJS.ProcessEnv, () => 0);
    expect(s()).toBe(false);
  });

  it('unset outside production ⇒ a dev placeholder rate the sample path can exercise', () => {
    const fires = envSampler({} as NodeJS.ProcessEnv, () => 0); // rng 0 < any positive rate
    const misses = envSampler({} as NodeJS.ProcessEnv, () => 0.99);
    expect(fires()).toBe(true);
    expect(misses()).toBe(false);
  });

  it('a coherent rate compares against the rng', () => {
    const env = { REPID_PREDICT_SAMPLE_RATE: '0.5' } as NodeJS.ProcessEnv;
    expect(envSampler(env, () => 0.4)()).toBe(true);
    expect(envSampler(env, () => 0.6)()).toBe(false);
    expect(envSampler({ REPID_PREDICT_SAMPLE_RATE: '1' } as NodeJS.ProcessEnv, () => 0.999)()).toBe(true);
  });

  it('an incoherent or out-of-range rate ⇒ sampling off, never a guess', () => {
    expect(envSampler({ REPID_PREDICT_SAMPLE_RATE: 'abc' } as NodeJS.ProcessEnv, () => 0)()).toBe(false);
    expect(envSampler({ REPID_PREDICT_SAMPLE_RATE: '2' } as NodeJS.ProcessEnv, () => 0)()).toBe(false);
    expect(envSampler({ REPID_PREDICT_SAMPLE_RATE: '-1' } as NodeJS.ProcessEnv, () => 0)()).toBe(false);
  });
});
