# Answer key, first slice: the 2026-10-06 run

S46, Sean's GO on 2026-10-06.

The answer key is an index that sits beside the checker ledger. For a claim **we** put in it, it records which public record supports it, which contradicts it, or that nothing decided it. Every record it relies on can be fetched again by anyone.

It is **off the stamp path**. Nothing in `/api/v1/classify` reads it (`tests/answer-key-run.test.ts` pins that), and no model is asked anything.

## What decides, and what never does

| source | decides when | never decides on |
|---|---|---|
| npm, PyPI | The registry's own answer. A 200 that lists the version means it exists; a 404 means it is absent. | A 5xx, a proxy refusal, a timeout, a body that is not JSON |
| Wikidata | A **referenced** value of the best rank, read at a pinned revision. A differing value contradicts only for a property that holds one value. | No reference; a reference that only says where a value was imported from (P143, P4656); a value in another unit; a property that may hold many values |
| arXiv (second slice) | The paper's own entry. "First posted" is its `<published>` time, which arXiv defines as when version 1 was submitted. The author count is read from the latest version, and the record pins that version. | An entry whose title is not the one our claim names (the id points at another paper); no entry; a 5xx; a body that is not an Atom feed; more than one entry for one id |
| Published fact-checks (Google Fact Check Tools) | Never. The reviews are attached for a person to judge. | Everything. Whether a review is about this exact claim, and what its free-text rating means, is a person's call. |

There are three outcomes, never two: `supports`, `contradicts` and `unchecked`. An unchecked check is kept, and it stays unchecked.

## The run

There are 14 claims, all our own (`seed-2026-10-06.jsonl`). Each carries the structured spec that is actually checked, never free text to match.

| claim | outcome | why |
|---|---|---|
| Version 4.18.2 of express is published | supports | npm lists it |
| Version 5.0.0 of lodash is published | **contradicts** | npm lists no 5.0.0; the latest is 4.18.1 |
| `@hyperdag/trustshell` 1.6.0 is published | supports | npm lists it |
| `@hyperdag/protocol` is published | **contradicts** | npm has no such package. Our own README once implied it was published. |
| `trustshell-nonexistent-demo-package-2026` is published | **contradicts** | npm 404. This stands in for a package name an AI made up. |
| requests 2.31.0 is on PyPI | supports | PyPI lists it |
| numpy 3.0.0 is on PyPI | **contradicts** | PyPI lists no 3.0.0; the latest is 2.5.3 |
| Python was first released in 1991 | supports | Wikidata Q28865 P571 is 1991-02-20, referenced to docs.python.org |
| The capital of Australia is Sydney | **contradicts** | Wikidata Q408 P36, preferred value Canberra, referenced to australia.gov.au |
| *Attention Is All You Need* was published in 2017 | unchecked | The value matches, but it has no reference |
| *On the Origin of Species* was published in 1859 | unchecked | The value matches, but its only reference is "imported from English Wikipedia" |
| Mount Everest is 8,849 metres tall | supports | Wikidata Q513 P2044 is 8,848.86 m, preferred, referenced to the BBC and Der Spiegel |
| Microsoft was founded in 1976 | **contradicts** | Wikidata Q2283 P571 is 1975-04-04, referenced to news.microsoft.com |
| Einstein said "insanity is doing the same thing…" | unchecked | No Fact Check Tools key here, so nothing was searched (NOT CHECKED) |

The totals are 5 supports, 6 contradicts and 3 unchecked. These are **14 hand-picked claims, not a sample**: the run shows the mechanism, not a rate.

## How it was read, exactly

**npm and PyPI** were read live from the machine that ran `npm run answer-key` (2026-10-06, about 19:40Z).

**Wikidata** could not be reached from that machine: its network proxy refused `wikidata.org` (CONNECT 403). So the 13 Wikidata responses were fetched through Supabase `pg_net`, a different network path, with the same URLs and the same `User-Agent`:
- Postgres computed the sha256 of each response body as received.
- Each body was copied into `relay-2026-10-06.json`.
- Each copy was checked against that sha256. All 13 match.

The runner then used those bodies through its `--relay` option, and every row says which URLs came that way.

Each Wikidata row's record pins the entity revision it was read at. For example, `https://www.wikidata.org/wiki/Special:EntityData/Q2283.json?revision=2550576892` re-reads exactly what was compared.

## Files

| file | what it is |
|---|---|
| `seed-2026-10-06.jsonl` | the 14 claims and their specs |
| `relay-2026-10-06.json` | the 13 Wikidata response bodies, byte for byte (Wikidata content is CC0) |
| `run-2026-10-06.jsonl` | every result: outcome, reason, checker, and the record with its URL, sha256 and a small extract |
| `run-2026-10-06.sql` | idempotent SQL that loads the run into the `ak_*` tables once the migration is applied |

## Second slice: arXiv (2026-10-06)

This slice has 7 more claims of our own (`seed-arxiv-2026-10-06.jsonl`).

| claim | outcome | why |
|---|---|---|
| *Attention Is All You Need* was first posted to arXiv on 12 June 2017 | supports | arXiv 1706.03762 `<published>` is 2017-06-12T17:57:34Z |
| *Attention Is All You Need* lists eight authors on arXiv | supports | v7 lists 8 |
| *Attention Is All You Need* was first posted to arXiv in 2016 | **contradicts** | first posted in 2017 |
| BERT was first posted to arXiv in 2018 | supports | arXiv 1810.04805 `<published>` is 2018-10-11T00:50:01Z |
| The BERT paper lists five authors on arXiv | **contradicts** | v2 lists 4 |
| *Attention Is All You Need* is arXiv 1810.04805, first posted in 2018 | unchecked | That id is BERT. The record's title is not the one the claim names, so it must not lend BERT's date to another paper. |
| arXiv 2401.99999 was first posted in 2024 | unchecked | arXiv returned no entry |

The totals are 3 supports, 2 contradicts and 2 unchecked. These are hand-picked again: they show the mechanism, not a rate.

**This does not change the first slice's Attention row.** That claim says the paper was *published* in 2017, and it stays unchecked. Being posted to arXiv is a narrower claim, so it is a separate claim here, decided by its own record. One record is not stretched to cover a claim it does not state.

**How it was read.** This machine's proxy refuses arXiv too, so the 3 feeds came through Supabase `pg_net` in the same way as the Wikidata bodies:
- Postgres computed each sha256 as received.
- The copies are in `relay-arxiv-2026-10-06.json`.
- All 3 match their sha256 and length.

The three requests were spaced a few seconds apart, as arXiv's API asks.

**Database.** `ak_records.kind` listed four kinds, so `20261006170000_answer_key_arxiv.sql` widens that one check and changes nothing else. Apply it after `20261006160000`. On a scratch Postgres 16:
- loading this run without it fails on the check;
- with it, the run loads twice with no duplicates;
- the result is 7 checks and 3 arXiv records.

The BERT record is shared by the two claims that read it.

## Run it again

```bash
# Everything live (on a machine that can reach wikidata.org):
npm run answer-key -- check eval/answer-key/seed-2026-10-06.jsonl --out run.jsonl --sql run.sql

# The arXiv slice (a GitHub runner reaches export.arxiv.org directly):
npm run answer-key -- check eval/answer-key/seed-arxiv-2026-10-06.jsonl --out run.jsonl --sql run.sql

# The relayed halves offline, from the exact bytes read on 2026-10-06:
npx jest --config jest.config.js tests/answer-key-run
```

A later run's checks **supersede** this run's checks, claim by claim, and nothing is deleted.

The migration (`supabase/migrations/20261006160000_answer_key_graph.sql`) was applied to a scratch Postgres 16 with Supabase's default grants to `anon` and `authenticated` in place. In that test:
- This run loaded twice with no duplicates.
- A second run superseded all 14 checks.
- The guard refused an update, a delete, a supersede across claims, a supersede of a later check, a verdict with no record, and a claim not from our own sets.
- Neither `anon` nor `authenticated` could read or write any of it.
