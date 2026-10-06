/**
 * THE ANSWER KEY, FIRST SLICE (S46, Sean's GO 2026-10-06).
 *
 * An index beside the checker ledger, OFF the stamp path. Nothing in a route or in the classify
 * pipeline reads it (the 'off the stamp path' test in tests/answer-key-run.test.ts pins that). It
 * answers one question about a claim WE put in it: which re-checkable public record supports it or
 * contradicts it.
 *
 * WHAT IT IS NOT. Two models agreeing is not a record, so no model is asked anything here. A claim is
 * never matched by pattern against free text: every claim carries a structured spec (a package and a
 * version, an entity and a property), and only that spec is checked. Free-text matching is the
 * failure mode this exists to avoid.
 *
 * THREE OUTCOMES, NEVER TWO. `supports`, `contradicts`, or `unchecked`. A network failure, a proxy
 * refusal, a missing key, a value with no reference, or a property that may hold many values all
 * land on `unchecked`, never on either verdict. An unchecked link is kept and stays marked unchecked.
 *
 * NO USER TEXT. Claims come from our own labelled sets and curated seeds only (ak_claims.source).
 */

export type AnswerOutcome = 'supports' | 'contradicts' | 'unchecked';

export type RecordKind = 'npm' | 'pypi' | 'wikidata' | 'claimreview' | 'arxiv';

/** Wikidata values the first slice can compare exactly. */
export type WikidataExpected =
  | { type: 'item'; id: string }
  | { type: 'year'; year: number }
  /** `unit` is the unit's item id (Q11573 is the metre). A value in another unit is not compared. */
  | { type: 'quantity'; amount: number; tolerance: number; unit: string }
  | { type: 'string'; value: string };

export type ClaimSpec =
  | { kind: 'npm-package'; name: string; version?: string; asserts: 'exists' | 'absent' }
  | { kind: 'pypi-package'; name: string; version?: string; asserts: 'exists' | 'absent' }
  | {
      kind: 'wikidata';
      entity: string;
      property: string;
      expected: WikidataExpected;
      /**
       * True only for a property that holds one current value (a date of birth, a capital today).
       * Only then can a referenced value that differs CONTRADICT the claim. For a property that may
       * hold many values (authors, awards) a miss is `unchecked`: the list may be incomplete.
       */
      single: boolean;
    }
  | { kind: 'claimreview'; query: string }
  | {
      kind: 'arxiv';
      /** A bare arXiv id, with no version: the latest version is read, and the record pins which. */
      id: string;
      /**
       * The paper's title as our claim names it. The record must carry this title, or the spec points
       * at another paper and nothing is decided: a wrong id must not borrow another paper's dates.
       */
      title: string;
      expected: ArxivExpected;
    };

/**
 * What an arXiv entry can decide. arXiv's `<published>` is when VERSION 1 was submitted (UTC), so
 * "first posted" is a property of the paper, not of the version read. The author list is read from
 * the latest version, and the record says which version that was.
 */
export type ArxivExpected =
  | { type: 'first-posted'; date: string }
  | { type: 'first-posted-year'; year: number }
  | { type: 'author-count'; count: number };

/** A public record anyone can fetch again: the locator pins the exact version that was read. */
export interface RecordRef {
  kind: RecordKind;
  /** e.g. `npm:express`, `pypi:requests`, `wikidata:Q937#P569@rev2213456789`. */
  locator: string;
  /** The URL that re-reads exactly this record (a Wikidata URL carries the revision). */
  url: string;
  fetchedAt: string;
  /** sha256 of the response body as received. */
  sha256: string;
  /** A small, fixed-shape extract of the record: never the whole body. */
  snapshot: Record<string, unknown>;
}

export interface Finding {
  outcome: AnswerOutcome;
  /** One plain sentence: what was read and why it decides, or why it does not. */
  reason: string;
  /** Present whenever a record was actually read, including on `unchecked`. */
  record?: RecordRef;
  /** Which checker produced this, with its rule version: `npm-registry@1`. */
  checker: string;
}

/** One curated claim: our own sentence, and the spec that is actually checked. */
export interface SeedClaim {
  id: string;
  claim: string;
  spec: ClaimSpec;
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;
