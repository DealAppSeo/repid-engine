/**
 * RETIRED PUBLIC HOLDOUT (Sean, BUS S60, 2026-10-07): "retire and replace".
 *
 * The holdout splits of rigorous-v1 (99 rows) and canary-v1 (15), and every copy of them, have been
 * public in git since July 2026, and a `source_id` field gives the label away on 190 of the 337
 * rigorous rows. Stripping the text now unpublishes nothing (it stays in history), so those splits
 * are no longer a holdout. They stay in the repo as training, regression and practice sets.
 *
 * The retirement is recorded ONCE, as data, in data/hal_corpus_v1/MANIFEST.json
 * (`retired_as_holdout`, `retired_reason`, `retired_copies`). Every script that prints or writes a
 * score computed on those sets reads it from there and stamps its result with
 * `holdout: "retired-public"`, so a number taken on a public set cannot be quoted as a holdout
 * number. The measurement holdout is private: eval/holdout/README.md.
 *
 * If the manifest stops recording the retirement, retiredRecord() throws: a script refuses to print
 * a score rather than print one without its label.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const RETIRED_PUBLIC = 'retired-public' as const;
export const CORPUS_MANIFEST = join(__dirname, '..', '..', 'data', 'hal_corpus_v1', 'MANIFEST.json');

export interface RetiredRecord {
  /** The day the public splits stopped being a holdout. */
  date: string;
  reason: string;
  /** Every committed copy of the retired sentences (from the F-2 inventory). */
  copies: string[];
}

export interface RetiredStamp {
  holdout: typeof RETIRED_PUBLIC;
  retired_as_holdout: string;
}

export function retiredRecord(manifestPath: string = CORPUS_MANIFEST): RetiredRecord {
  const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const date = m['retired_as_holdout'];
  const reason = m['retired_reason'];
  const copies = m['retired_copies'];
  if (
    typeof date !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    typeof reason !== 'string' ||
    !reason.trim() ||
    !Array.isArray(copies) ||
    copies.length === 0 ||
    !copies.every((c) => typeof c === 'string')
  ) {
    throw new Error(
      `${manifestPath} does not record the holdout retirement (retired_as_holdout, retired_reason, retired_copies). ` +
        'Refusing to print a score that could read as a holdout score.',
    );
  }
  return { date, reason, copies: copies as string[] };
}

/** The one printed line every score on a retired public set carries. */
export function retiredLine(set: string, rec: RetiredRecord = retiredRecord()): string {
  return `RETIRED PUBLIC SET: ${set} is public in git (retired as a holdout ${rec.date}). This is NOT a holdout score.`;
}

/** The fields every written result on a retired public set carries. */
export function retiredStamp(rec: RetiredRecord = retiredRecord()): RetiredStamp {
  return { holdout: RETIRED_PUBLIC, retired_as_holdout: rec.date };
}
