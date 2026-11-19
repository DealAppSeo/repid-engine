Ruler: corpus 5d53501c22a92f78 (24 cases: 12 planted, 12 clean; real `node --test` output, node v22.17.0); grader grok-review.v5 judge 185d8950238036e0; review-chain ae366fd474172e52; harness 7e773f718a62073c.

| reviewer (family) | runs | usable | planted: caught (CR) | planted: right item/line | planted: PASSed (worst miss) | clean: false alarm | clean: PASS | provider failures (not counted) | bad replies | median s |
|---|---|---|---|---|---|---|---|---|---|---|
| `codex` (OpenAI GPT) | 48 | 47/48 (89-100%) | 23/23 (86-100%) | 23/23 (86-100%) | 0/23 | 5/24 (9-40%) | 7/24 (15-49%) | 0 | 1 (answer_rejected 1) | 44.8 |
| `open:cerebras/gpt-oss-120b` (OpenAI gpt-oss (open weights)) | 48 | 1/48 (0-11%) | 0/0 (n/a) | 0/0 (n/a) | 0/0 | 0/1 (0-79%) | 1/1 (21-100%) | 0 | 47 (answer_rejected 47) | 2.1 |
| `open:cerebras/qwen-3.8-27b` (Alibaba Qwen) | 48 | 46/48 (86-99%) | 20/22 (72-97%) | 20/22 (72-97%) | 0/22 | 0/24 (0-14%) | 22/24 (74-98%) | 0 | 2 (answer_rejected 2) | 1.2 |
| `open:nvidia-nim/google/gemma-4-31b-it` (Google Gemma) | 48 | 33/48 (55-80%) | 19/19 (83-100%) | 19/19 (83-100%) | 0/19 | 0/14 (0-22%) | 11/14 (52-92%) | 0 | 15 (answer_rejected 15) | 40.9 |
| `open:nvidia-nim/mistralai/mistral-large-4-1t-a52b` (Mistral) | 2 | 0/0 (n/a) | 0/0 (n/a) | 0/0 (n/a) | 0/0 | 0/0 (n/a) | 0/0 (n/a) | 2 (timeout 2) | 0 | 240.1 |
| `open:openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` (NVIDIA Nemotron) | 48 | 24/48 (36-64%) | 10/10 (72-100%) | 9/10 (60-98%) | 0/10 | 0/14 (0-22%) | 13/14 (69-99%) | 0 | 24 (answer_rejected 24) | 52.4 |

Planted defects by kind: caught with the right item or line / usable runs on that kind

| reviewer | contradicted_claim | failing_run | inverted_logic | secret | swallowed_error | tautological_catch | tautological_mock | unexplained_file |
|---|---|---|---|---|---|---|---|---|
| `codex` | 2/2 | 2/2 | 5/5 | 4/4 | 4/4 | 2/2 | 2/2 | 2/2 |
| `open:cerebras/gpt-oss-120b` | - | - | - | - | - | - | - | - |
| `open:cerebras/qwen-3.8-27b` | 2/2 | 2/2 | 4/6 | 4/4 | 2/2 | 2/2 | 2/2 | 2/2 |
| `open:nvidia-nim/google/gemma-4-31b-it` | 2/2 | 2/2 | 1/1 | 4/4 | 4/4 | 2/2 | 2/2 | 2/2 |
| `open:nvidia-nim/mistralai/mistral-large-4-1t-a52b` | - | - | - | - | - | - | - | - |
| `open:openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` | 1/1 | 1/1 | 2/3 | 3/3 | 1/1 | - | - | 1/1 |

usable = a reply that parsed, named this commit, and passed every quote check; denominators exclude provider failures. 95% Wilson intervals; fewer than 30 judged runs per cell is NOISE, so no order is claimed where intervals overlap.
