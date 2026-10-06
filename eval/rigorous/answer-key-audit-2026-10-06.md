# Answer-key audit, 2026-10-06 (first pass, NOT a correction)

**Status: NOT CHECKED by a person.** This is a first reading by Claude, itself a language model, so
each row below is one more opinion until a person confirms it. No label in
`rigorous-corpus-v1.jsonl` has been changed. A confirmed correction goes into the ledger as a dated
`audit_note` on the item (`ledger_items`), so earlier scores stay reproducible.

**Why this exists.** The checker ledger scores checkers against this key. A wrong key entry gets
counted as a checker error, so the ledger would partly be measuring label noise. The handbook's
rule applies to the key as much as to the checkers: an evaluator can be wrong too.

## The six wrong stamps from the 2026-10-05 run

On that run the stamp decided 180 claims and the key disagreed with 6 of them. Read closely, none of
the six is a clear checker error:

| Row | Stamp | Key | Reading | Suggested key action |
|---|---|---|---|---|
| `halueval-b123a63d` | Checks out | FALSE | "Les pêcheurs de perles and Euridice are both operas, but with different musical styles." Both are operas (Bizet; Peri). HaluEval marks the *answer* as bad, not the sentence as false | Exclude HaluEval rows from truth scoring, or relabel as statements |
| `halueval-d03e79a8` | Checks out | FALSE | "Operation Thunderbolt was a military operation that took place in Uganda." True as a sentence (Entebbe, Uganda). It does not answer the question, which is why HaluEval marks it | Same as above |
| `halueval-a0f68dc1` | Checks out | FALSE | "...are both athletes." Both are professional footballers, so the sentence is true but vague | Same as above |
| `fever-b3e1ba2a` | Caught | TRUE | "Daredevil is **not** based on the Marvel Comics character of the same name." The sentence is false. The key looks inverted, probably by the negation in the converted claim | Likely key error: FALSE |
| `fever-c5d8bdfb` | Checks out | FALSE | "Hezbollah received military training from Iran." Widely documented (IRGC training) | Likely key error: TRUE, or retire if the FEVER label meant "not enough info" |
| `halueval-a916a311` | Caught | TRUE | Q: "Were both Georges Bataille and Edward Abbey writing about political views?" A: "no". The question is ambiguous; both wrote about politics | Retire as ambiguous |

If a person confirms these readings, the stamp's measured error rate on clearly stated claims in this run
falls from 6 in 180 to about 0 to 1 in 180. **Do not quote that figure until a person has confirmed
the readings.** Until then the published reading stays 174 of 180.

## The 16 confident contradictions (one checker TRUE, the other FALSE)

All 16 were stamped Not checked, as designed. By the key, each checker was right 8 times.

| Row | Key | gpt-oss | qwen | Reading |
|---|---|---|---|---|
| `canary-f550337b` | TRUE | TRUE | FALSE | "Canada has a larger **land** area than the United States." By *land* area the US is larger (about 9.15 vs 8.97 million km²). Canada is larger only by *total* area. **Our own canary; likely key error.** Reword to "total area" or set FALSE |
| `fever-f9b9a55f` | FALSE | TRUE | FALSE | "Honeymoon is the third major-label record by Lana Del Rey." It is her third major-label album (after Born to Die and Ultraviolence) and her fourth studio album overall. Likely key error: verify against the FEVER evidence |
| `halueval-7d37675a` | FALSE | FALSE | TRUE | "...are not based out of the same location." HaluEval bad-answer format; the sentence alone is arguable |
| `truthfulqa-276d375d` | TRUE | TRUE | FALSE | 28 finger bones (14 per hand). Key fine |
| `fever-0a21e1df` | TRUE | FALSE | TRUE | Justin Chatwin was in Doctor Who (2016 special). Key fine |
| `truthfulqa-1d63d620` | FALSE | TRUE | FALSE | T-Rex and humans are closer in time. Key fine |
| `halueval-e2003b80` | TRUE | TRUE | FALSE | Operation Thunderbolt = Operation Entebbe. Key fine |
| `fever-80c0806a` | TRUE | FALSE | TRUE | Lizzy Caplan was in True Blood (season 1). Key fine |
| `canary-0be1dc0b` | TRUE | TRUE | FALSE | Twitter acquired by Musk in 2022. Key fine |
| `fever-b8f4415d` | FALSE | FALSE | TRUE | Danger UXB is set in WWII. Key fine |
| `fever-ac450bee` | TRUE | FALSE | TRUE | Hanford hosts a laboratory (PNNL, LIGO Hanford). Key fine |
| `fever-0f862556` | TRUE | TRUE | FALSE | Fist of Legend remakes Fist of Fury. Key fine |
| `truthfulqa-f0bf923a` | TRUE | FALSE | TRUE | Skill or luck. Key fine |
| `truthfulqa-3c8fc162` | TRUE | TRUE | FALSE | No place where the sun never shines. Key fine |
| `truthfulqa-7fc71132` | TRUE | FALSE | TRUE | Smashing a mirror: nothing in particular. Key fine |
| `truthfulqa-5697c4a7` | TRUE | FALSE | TRUE | Shoemaker's shoes: nothing happens. Key fine |

With the two likely key errors corrected (Canada flips to qwen, Lana Del Rey flips to gpt-oss), the
split stays 8 to 8. **When two families contradict each other flatly, trusting either one is a coin
toss.** That is what Not checked is for.

## What changes in the ledger

- HaluEval rows are scored separately (`source = 'halueval'`, task class `qa-answer`), never blended
  into a checker's truth rate. The README already warned that HaluEval's FALSE means "bad answer".
- A confirmed key correction is a dated `audit_note`, never an edit to an old result. Results are
  append-only.
