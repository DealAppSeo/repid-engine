/**
 * The four record sources of the answer key's first slice (S46). Each reads ONE public record and
 * answers supports / contradicts / unchecked for a structured spec. See ./types.ts for the rules.
 *
 * What decides, per source:
 *   npm, PyPI   The registry's own answer. 200 with the version listed: it exists. 404: it does not.
 *               Anything else (a 5xx, a proxy refusal, a timeout, a body that is not JSON): unchecked.
 *   Wikidata    A statement's value, and only a REFERENCED one decides (an "imported from Wikimedia"
 *               note is not a reference). Read at a pinned revision. A quantity is compared in its unit. Best rank only (preferred if
 *               any, else normal; deprecated never). A matching value with no reference is unchecked.
 *               A differing value contradicts only when the spec says the property holds one value.
 *   ClaimReview Published fact-checks are RELATED records, never a verdict: whether a review is about
 *               this exact claim, and what its free-text rating means, is a person's call. Always
 *               unchecked, with the reviews attached so a person can decide. No key: unchecked.
 *
 * Under ONLY_ATTESTATIONS_LEAVE nothing is fetched: every check is unchecked.
 */
import { createHash } from 'node:crypto';
import { onlyAttestationsLeave } from '../selfhost/egress-guard';
import type { ClaimSpec, FetchLike, Finding, RecordRef, WikidataExpected } from './types';

export const CHECKERS = {
  npm: 'npm-registry@1',
  pypi: 'pypi-json@1',
  wikidata: 'wikidata-entity@1',
  claimreview: 'claimreview-search@1',
} as const;

/** Wikidata's policy asks every client to say who it is. */
export const USER_AGENT = 'TrustShellAnswerKey/1 (https://github.com/DealAppSeo/repid-engine)';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BODY_CHARS = 5_000_000;

const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const PYPI_VERSION = /^[0-9A-Za-z.!+_-]{1,64}$/;
const WD_ENTITY = /^Q[1-9]\d{0,11}$/;
const WD_PROPERTY = /^P[1-9]\d{0,7}$/;

export interface CheckDeps {
  fetch: FetchLike;
  now?: () => Date;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

type Got = { kind: 'body'; status: number; body: string } | { kind: 'failed'; why: string };

async function get(deps: CheckDeps, url: string, headers: Record<string, string> = {}): Promise<Got> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await deps.fetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers }, signal: controller.signal });
    const body = await res.text();
    if (typeof body !== 'string' || body.length > MAX_BODY_CHARS) return { kind: 'failed', why: 'the body was too large to be a record' };
    return { kind: 'body', status: res.status, body };
  } catch (e) {
    const name = (e as { name?: string })?.name;
    return { kind: 'failed', why: name === 'AbortError' ? 'no answer in time' : 'the request failed' };
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(body: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(body);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const unchecked = (checker: string, reason: string, record?: RecordRef): Finding => ({
  outcome: 'unchecked',
  reason,
  checker,
  ...(record ? { record } : {}),
});

/** exists / absent, and what that means for the claim. */
function existence(checker: string, asserts: 'exists' | 'absent', exists: boolean, what: string, record: RecordRef): Finding {
  const holds = asserts === 'exists' ? exists : !exists;
  return {
    outcome: holds ? 'supports' : 'contradicts',
    reason: `${what} ${exists ? 'is published' : 'is not published'}.`,
    checker,
    record,
  };
}

async function checkNpm(spec: Extract<ClaimSpec, { kind: 'npm-package' }>, deps: CheckDeps): Promise<Finding> {
  const checker = CHECKERS.npm;
  if (!NPM_NAME.test(spec.name) || spec.name.length > 214) return unchecked(checker, 'not a valid npm package name');
  if (spec.version !== undefined && !SEMVER.test(spec.version)) return unchecked(checker, 'not a valid npm version');
  const url = `https://registry.npmjs.org/${spec.name.replace('/', '%2f')}`;
  // The abbreviated document: names, dist-tags and versions, without every readme.
  const got = await get(deps, url, { Accept: 'application/vnd.npm.install-v1+json' });
  if (got.kind === 'failed') return unchecked(checker, `npm registry: ${got.why}`);
  const fetchedAt = (deps.now ?? (() => new Date()))().toISOString();
  const what = spec.version ? `${spec.name}@${spec.version} on npm` : `${spec.name} on npm`;
  const base = { kind: 'npm' as const, locator: `npm:${spec.name}`, url: `https://www.npmjs.com/package/${spec.name}`, fetchedAt, sha256: sha256(got.body) };
  if (got.status === 404) return existence(checker, spec.asserts, false, what, { ...base, snapshot: { name: spec.name, found: false } });
  if (got.status !== 200) return unchecked(checker, `npm registry answered HTTP ${got.status}`);
  const doc = parseJson(got.body);
  const versions = doc && doc.versions && typeof doc.versions === 'object' ? Object.keys(doc.versions as object) : null;
  if (!doc || !versions) return unchecked(checker, 'npm registry: the body was not a package document');
  const latest = (doc['dist-tags'] as { latest?: unknown } | undefined)?.latest;
  const exists = spec.version ? versions.includes(spec.version) : true;
  return existence(checker, spec.asserts, exists, what, {
    ...base,
    snapshot: { name: spec.name, found: true, latest: typeof latest === 'string' ? latest : null, versions: versions.length, ...(spec.version ? { hasVersion: exists } : {}) },
  });
}

async function checkPypi(spec: Extract<ClaimSpec, { kind: 'pypi-package' }>, deps: CheckDeps): Promise<Finding> {
  const checker = CHECKERS.pypi;
  if (!PYPI_NAME.test(spec.name) || spec.name.length > 100) return unchecked(checker, 'not a valid PyPI project name');
  if (spec.version !== undefined && !PYPI_VERSION.test(spec.version)) return unchecked(checker, 'not a valid PyPI version');
  const url = `https://pypi.org/pypi/${spec.name}/json`;
  const got = await get(deps, url);
  if (got.kind === 'failed') return unchecked(checker, `PyPI: ${got.why}`);
  const fetchedAt = (deps.now ?? (() => new Date()))().toISOString();
  const what = spec.version ? `${spec.name} ${spec.version} on PyPI` : `${spec.name} on PyPI`;
  const base = { kind: 'pypi' as const, locator: `pypi:${spec.name.toLowerCase()}`, url: `https://pypi.org/project/${spec.name}/`, fetchedAt, sha256: sha256(got.body) };
  if (got.status === 404) return existence(checker, spec.asserts, false, what, { ...base, snapshot: { name: spec.name, found: false } });
  if (got.status !== 200) return unchecked(checker, `PyPI answered HTTP ${got.status}`);
  const doc = parseJson(got.body);
  const releases = doc && doc.releases && typeof doc.releases === 'object' ? Object.keys(doc.releases as object) : null;
  if (!doc || !releases) return unchecked(checker, 'PyPI: the body was not a project document');
  const latest = (doc.info as { version?: unknown } | undefined)?.version;
  const exists = spec.version ? releases.includes(spec.version) : true;
  return existence(checker, spec.asserts, exists, what, {
    ...base,
    snapshot: { name: spec.name, found: true, latest: typeof latest === 'string' ? latest : null, releases: releases.length, ...(spec.version ? { hasVersion: exists } : {}) },
  });
}

type Statement = { rank?: string; mainsnak?: { snaktype?: string; datavalue?: { type?: string; value?: unknown } }; references?: unknown[] };

/** The value of a statement as one comparable string, or null when it has none of a usable type. */
export function statementValue(s: Statement): string | null {
  const snak = s.mainsnak;
  if (!snak || snak.snaktype !== 'value' || !snak.datavalue) return null;
  const { type, value } = snak.datavalue;
  const v = value as Record<string, unknown> | string;
  if (type === 'wikibase-entityid' && typeof v === 'object' && typeof v.id === 'string') return v.id;
  if (type === 'time' && typeof v === 'object' && typeof v.time === 'string' && typeof v.precision === 'number') {
    if (v.precision < 9) return null; // coarser than a year: no year to compare
    const m = /^([+-])(\d{1,16})-/.exec(v.time);
    return m ? String(Number(m[2]) * (m[1] === '-' ? -1 : 1)) : null;
  }
  if (type === 'quantity' && typeof v === 'object' && typeof v.amount === 'string') {
    const n = Number(v.amount);
    return Number.isFinite(n) ? String(n) : null;
  }
  if (type === 'string' && typeof v === 'string') return v;
  if (type === 'monolingualtext' && typeof v === 'object' && typeof v.text === 'string') return v.text;
  return null;
}

/** true / false, or null when the statement's value is not the expected type at all. */
export function matches(s: Statement, expected: WikidataExpected): boolean | null {
  const value = statementValue(s);
  if (value === null) return null;
  const type = s.mainsnak?.datavalue?.type;
  switch (expected.type) {
    case 'item':
      return type === 'wikibase-entityid' ? value === expected.id : null;
    case 'year':
      return type === 'time' ? Number(value) === expected.year : null;
    case 'quantity': {
      if (type !== 'quantity') return null;
      // Unit-blind comparison would let 29,030 feet "contradict" 8,849 metres. Another unit: not compared.
      const unit = (s.mainsnak?.datavalue?.value as { unit?: unknown } | undefined)?.unit;
      if (typeof unit !== 'string' || unit.split('/').pop() !== expected.unit) return null;
      return Math.abs(Number(value) - expected.amount) <= expected.tolerance;
    }
    case 'string':
      return type === 'string' || type === 'monolingualtext' ? value === expected.value : null;
  }
}

/**
 * Wikidata's own guidance: "imported from Wikimedia project" (P143) and "Wikimedia import URL" (P4656)
 * say where a bot copied a value from, not where it is sourced. A reference made only of those is
 * no reference.
 */
const IMPORT_ONLY = new Set(['P143', 'P4656']);
export const referenced = (s: Statement) =>
  Array.isArray(s.references) &&
  s.references.some((r) => {
    const snaks = (r as { snaks?: Record<string, unknown> } | null)?.snaks;
    return !!snaks && typeof snaks === 'object' && Object.keys(snaks).some((k) => !IMPORT_ONLY.has(k));
  });

const WD_API = 'https://www.wikidata.org/w/api.php';

/**
 * Two small reads, not the whole entity (Einstein's document alone is hundreds of KB): the entity's
 * current revision (wbgetentities, props=info, which also follows a redirect from a merged item), then
 * only the property in question (wbgetclaims). The record pins that revision, so anyone can re-read
 * exactly what was compared through Special:EntityData/<id>.json?revision=<n>.
 */
async function checkWikidata(spec: Extract<ClaimSpec, { kind: 'wikidata' }>, deps: CheckDeps): Promise<Finding> {
  const checker = CHECKERS.wikidata;
  if (!WD_ENTITY.test(spec.entity) || !WD_PROPERTY.test(spec.property)) return unchecked(checker, 'not a valid Wikidata entity or property id');
  const info = await get(deps, `${WD_API}?action=wbgetentities&ids=${spec.entity}&props=info&format=json`);
  if (info.kind === 'failed') return unchecked(checker, `Wikidata: ${info.why}`);
  if (info.status !== 200) return unchecked(checker, `Wikidata answered HTTP ${info.status}`);
  const entities = parseJson(info.body)?.entities;
  const [, entity] = entities && typeof entities === 'object' ? (Object.entries(entities as Record<string, unknown>)[0] ?? []) : [];
  const ent = entity as { id?: unknown; lastrevid?: unknown; missing?: unknown } | undefined;
  if (!ent || ent.missing !== undefined || typeof ent.id !== 'string' || !WD_ENTITY.test(ent.id) || typeof ent.lastrevid !== 'number') {
    return unchecked(checker, `Wikidata has no entity ${spec.entity}`);
  }
  const id = ent.id;
  const got = await get(deps, `${WD_API}?action=wbgetclaims&entity=${id}&property=${spec.property}&format=json`);
  if (got.kind === 'failed') return unchecked(checker, `Wikidata: ${got.why}`);
  if (got.status !== 200) return unchecked(checker, `Wikidata answered HTTP ${got.status}`);
  const claims = parseJson(got.body)?.claims as Record<string, Statement[]> | undefined;
  if (!claims || typeof claims !== 'object') return unchecked(checker, 'Wikidata: the body was not a claims document');
  const all = (Array.isArray(claims[spec.property]) ? claims[spec.property]! : []).filter((s) => s.rank !== 'deprecated');
  const preferred = all.filter((s) => s.rank === 'preferred');
  const best = preferred.length > 0 ? preferred : all;
  const record: RecordRef = {
    kind: 'wikidata',
    locator: `wikidata:${id}#${spec.property}@rev${ent.lastrevid}`,
    url: `https://www.wikidata.org/wiki/Special:EntityData/${id}.json?revision=${ent.lastrevid}`,
    fetchedAt: (deps.now ?? (() => new Date()))().toISOString(),
    sha256: sha256(got.body),
    snapshot: {
      entity: id,
      property: spec.property,
      revision: ent.lastrevid,
      values: best.slice(0, 10).map((s) => ({ value: statementValue(s), referenced: referenced(s), rank: s.rank ?? 'normal' })),
    },
  };
  if (best.length === 0) return unchecked(checker, `Wikidata ${id} has no ${spec.property} statement.`, record);
  const hits = best.filter((s) => matches(s, spec.expected) === true);
  if (hits.some(referenced)) return { outcome: 'supports', reason: `Wikidata ${id} ${spec.property} holds this value, with a reference.`, checker, record };
  if (hits.length > 0) {
    const importOnly = hits.some((h) => Array.isArray(h.references) && h.references.length > 0);
    return unchecked(
      checker,
      importOnly
        ? `Wikidata ${id} ${spec.property} holds this value, but its only reference says where it was imported from, not a source.`
        : `Wikidata ${id} ${spec.property} holds this value, but with no reference.`,
      record,
    );
  }
  const comparable = best.filter((s) => matches(s, spec.expected) !== null);
  if (spec.single && comparable.length > 0 && comparable.length === best.length && best.some(referenced)) {
    const shown = comparable.filter(referenced).map(statementValue).slice(0, 3).join(', ');
    return { outcome: 'contradicts', reason: `Wikidata ${id} ${spec.property} holds ${shown}, with a reference.`, checker, record };
  }
  return unchecked(checker, `Wikidata ${id} ${spec.property} does not hold this value among ${best.length}; the list may be incomplete.`, record);
}

async function checkClaimReview(spec: Extract<ClaimSpec, { kind: 'claimreview' }>, deps: CheckDeps, key: string): Promise<Finding> {
  const checker = CHECKERS.claimreview;
  const query = spec.query.trim();
  if (query.length < 3 || query.length > 300) return unchecked(checker, 'the query is empty or too long');
  if (!key) return unchecked(checker, 'Google Fact Check Tools: no API key here, so nothing was searched (NOT CHECKED).');
  const params = new URLSearchParams({ query, languageCode: 'en', pageSize: '5' });
  // The key is sent, never stored: the record's url below is built without it.
  const got = await get(deps, `https://factchecktools.googleapis.com/v1alpha1/claims:search?${params.toString()}&key=${encodeURIComponent(key)}`);
  if (got.kind === 'failed') return unchecked(checker, `Google Fact Check Tools: ${got.why}`);
  if (got.status !== 200) return unchecked(checker, `Google Fact Check Tools answered HTTP ${got.status}`);
  const doc = parseJson(got.body);
  const claims = Array.isArray(doc?.claims) ? (doc!.claims as Array<Record<string, unknown>>) : [];
  const reviews = claims.slice(0, 5).map((c) => ({
    text: typeof c.text === 'string' ? c.text.slice(0, 300) : null,
    reviews: (Array.isArray(c.claimReview) ? (c.claimReview as Array<Record<string, unknown>>) : []).slice(0, 3).map((r) => ({
      publisher: (r.publisher as { site?: unknown } | undefined)?.site ?? null,
      url: typeof r.url === 'string' ? r.url : null,
      rating: typeof r.textualRating === 'string' ? r.textualRating.slice(0, 80) : null,
      date: typeof r.reviewDate === 'string' ? r.reviewDate : null,
    })),
  }));
  const record: RecordRef = {
    kind: 'claimreview',
    locator: `claimreview:${sha256(query).slice(0, 16)}`,
    url: `https://toolbox.google.com/factcheck/explorer/search/${encodeURIComponent(query)};hl=en`,
    fetchedAt: (deps.now ?? (() => new Date()))().toISOString(),
    sha256: sha256(got.body),
    snapshot: { query, found: claims.length, reviews },
  };
  return unchecked(
    checker,
    claims.length > 0
      ? `${claims.length} published fact-check(s) found. Whether one is about this exact claim is a person's call.`
      : 'No published fact-check found for this query.',
    record,
  );
}

/** Check one spec against its source. Never throws; never answers anything but the three outcomes. */
export async function checkSpec(spec: ClaimSpec, deps: CheckDeps): Promise<Finding> {
  const env = deps.env ?? process.env;
  const checker = CHECKERS[spec.kind === 'npm-package' ? 'npm' : spec.kind === 'pypi-package' ? 'pypi' : spec.kind];
  if (onlyAttestationsLeave(env)) return unchecked(checker, 'ONLY_ATTESTATIONS_LEAVE is set, so nothing was fetched.');
  try {
    switch (spec.kind) {
      case 'npm-package':
        return await checkNpm(spec, deps);
      case 'pypi-package':
        return await checkPypi(spec, deps);
      case 'wikidata':
        return await checkWikidata(spec, deps);
      case 'claimreview':
        return await checkClaimReview(spec, deps, (env === process.env ? process.env.GOOGLE_FACT_CHECK_API_KEY : env.GOOGLE_FACT_CHECK_API_KEY) ?? '');
    }
  } catch {
    return unchecked(checker, 'the check failed before it could read a record');
  }
}
