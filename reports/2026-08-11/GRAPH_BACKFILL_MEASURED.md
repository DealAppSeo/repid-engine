# Memory-graph backfill — measured, applied, and one earlier claim retracted

*All figures from live queries against project `qnnpjhlxljtqyigedwkb` on 2026-08-11. Every
query in here can be re-run.*

---

## 1. The claim I made three hours ago was wrong

`MEASURED_JUST_CULTURE_AND_CRITIQUE.md` §5 said:

> Backfill edges from data you already have and are not using as a graph — 152,130 score
> events, 1,307 fulfilled services, 403 settlements, 194 contracts all carry agent→agent and
> agent→artefact relations. That is **five orders of magnitude more edge material** than the
> 154 you have.

That was reasoning from row counts without looking at the schema. `repid_score_events` has
**no counterparty column** — one `agent_id` and nothing else. Its only relational hooks are
`contract_id`, `llm_call_id` and `zk_proof_id`:

| hook | distinct | shared by >1 agent |
|---|---:|---:|
| `llm_call_id` | 147,614 (of 147,614 events) | **0** |
| `zk_proof_id` | 119,310 | **0** |
| `contract_id` | 627 (614 with 2+ agents) | the only agent↔agent hook |

**Unique agent pairs recoverable from all 152,130 score events: 42.**

Adding the other two sources changes nothing — they are strict subsets:

| source | unique pairs |
|---|---:|
| shared `contract_id` in score events | 42 |
| `service_contracts` (buyer, provider) | 40 |
| `x402_settlements` (requestor, provider) | 20 |
| **union of all three** | **42** |

So the edge material is not five orders of magnitude larger than 154. It is **42 relationships**,
and I had already counted 154 edges — the graph was not starved of *this* kind of material at all.

Worse, the naive reading of my own recommendation would have actively harmed the thing it was
meant to fix. `llm_call_id` and `zk_proof_id` are strictly 1:1 with events, so transcribing
events into nodes creates roughly **267,000 degree-1 pendants**, driving mean degree *down* from
1.28 and burying the 213 real embedded nodes under noise in an HNSW index. That is the same
category of error as the searchable-encryption kill in `MESH_DATA_SHARING_BRAINSTORM.md` §7:
applying a technique to data that lacks the property the technique exploits.

**Retracted:** the "five orders of magnitude" figure and the framing of score events as edge
material. What follows replaces it.

---

## 2. What is actually in the data

Two things, and the backfill derives exactly those.

**Competence — aggregate, not transcript.** 152,130 events collapse into agent×domain cells.
At ≥5 events per cell: **104 cells across 20 agents**. This is the real win and it has nothing
to do with graph structure — before this, **zero** of those 152,130 events were reachable from
agent memory at all. Aggregation makes them retrievable without pretending each event is a
distinct memory.

**Counterparty — 42 pairs, one node per side = 84.** Aggregated per *pair*, never per contract:
per-contract nodes would be 614 pendants describing the same 42 relationships.

**Deliberately excluded: domain co-membership.** "Both agents worked in finance" would add 253
pairs from 163 events in that one domain, and near-cliques on a shared tag inflate degree
without giving a traversal anything to use. A graph that looks denser without being more
navigable is a worse lie than a sparse one.

---

## 3. What was applied

`migrations/2026-08-11-graph-rag-backfill-score-events.sql`, applied to production.

```
inserted   104 competence nodes · 84 counterparty nodes · 84 link edges · 67 competence edges
nodes      241 → 429        edges  154 → 305       mean degree (2E/V)  1.278 → 1.422
2-hop      264 → 331 pairs  ·  nodes with any 2-hop path  18 → 70
re-run     second apply inserted 0 of everything
```

Mean degree uses 2E/V — the same definition behind the "1.28" that motivated this work, so the
numbers are comparable.

The honest headline is **not** the degree number. 1.278 → 1.422 is a small move, and it is small
because the source data genuinely contains 42 relationships. What actually improved is 2-hop
reach: **18 → 70 nodes** now sit on some multi-hop path. The rest of the value is retrieval
surface, not topology.

**Design details worth knowing:**

- **Both edge directions are written.** `RetrievalService` traverses with
  `.eq('from_node_id', …)` only, so a single directed edge is a relationship half the mesh
  cannot see.
- **`reinforces` is reused in its plain sense** (this interaction evidences that competence).
  The edge-inference engine also emits `reinforces` from a cosine rule; `metadata.producer`
  distinguishes them, because `edge_type` alone cannot.
- **`importance` is a monotone function of evidence volume and nothing else.** It is not a
  quality score, was never fitted, and the formula is stated in the migration so nobody
  reverse-engineers a meaning it does not have.
- **HAL means are labelled RAW and uncalibrated** in the generated text (LESSONS #8) — the
  frozen calibrator is not applied on this path.
- **Negatives are labelled "detected, not self-reported"**, because all eight negative event
  types are detection-shaped. A memory that let a reader infer disclosure would misrepresent
  the just-culture state that the confession path was just built to fix.

---

## 4. Two things I got wrong while building it

**The generated content did not add up.** The first draft rendered:

> `32818 recorded outcomes … 0 positive, 12622 negative`

20,196 zero-delta events were silently omitted, and any reader would infer the remainder was
positive. Zero-delta is the *majority* in the largest cells. Both templates now report
positive / negative / neutral, and the counterparty template states the event total too. Checked
across all rows: `pos + neg + neutral = n` for **104 of 104** competence rows and **84 of 84**
counterparty rows.

**My first fence was vacuous.** The neutral-term assertion matched against the whole SQL file,
so deleting the term from the competence template left the test green — the *counterparty*
template satisfied the regex. Both assertions are now scoped to their own template slice, with
a guard-the-guard test that fails if a rename makes either slice empty. This is the fourth
mis-scoped grep in this repo; the durable lesson is not "be careful with grep" but "assert
against the narrowest slice that can distinguish the bug."

---

## 5. What is NOT done

**216 nodes have no embedding** — the 188 new ones plus 28 that predate this work.
`graph_rag_match_nodes` filters on `embedding IS NOT NULL`, so those nodes are traversable by
edge and queryable by agent but **invisible to vector search**, which is the primary retrieval
path. This backfill is therefore *half* wired, and saying otherwise would be the exact
false-coverage failure the confession-table work was about.

The reason is environmental, not architectural: SQL cannot run all-MiniLM-L6-v2, and this
session's egress proxy blocks `huggingface.co`, so the model could not be fetched here
(`Forbidden access to file: https://huggingface.co/Xenova/all-MiniLM-L6-v2/…`). The second pass
exists and is ready:

```bash
npm run graph-rag:backfill-embeddings              # dry-run
npm run graph-rag:backfill-embeddings -- --apply   # ~216 nodes
```

It only ever fills a NULL, never overwrites, and reports the true outstanding count so a
`--limit`ed run cannot read as a finished one. Run it anywhere with network access to the model —
Railway or a laptop both work.

**87 of the 188 new nodes are isolated** — competence cells for an (agent, domain) with no
counterparty in that domain. They are useful as retrievable facts once embedded, but they add
no traversal structure and are not counted as though they did. For scale, 207 of the 241
*pre-existing* nodes were already isolated; this backfill did not create that condition.

---

## 6. Revised recommendation on the GNN

Unchanged in direction, sharper in degree: **do not build it.** The earlier report deferred the
GNN pending "measure whether multi-hop retrieval beats single-hop on your own corpus." That
measurement is now cheap to run — 70 nodes have 2-hop paths where 18 did before — but the
ceiling is set by 42 relationships, not by ranking quality. A GNN over 305 edges would still be
learning noise.

The bottleneck was never edge *inference*. It is that the system does not **record**
agent↔agent relations when they happen: `repid_score_events` has no counterparty column, so
every interaction between two agents is stored twice as two unrelated single-agent rows, joined
only by an optional `contract_id` that 99.2% of events do not set. If richer graph structure is
wanted, the fix is upstream — capture the counterparty at write time — not a smarter reader
over data that never recorded it.
