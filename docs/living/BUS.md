# BUS — TrustShell MVP → shippable E2E
Updated 2026-09-19.

## Closed on branches (not published)
E1 unique evidence_id. E2 exclusive floor + window. E3 SQL written not applied. E4 happy-path settle fixtures. E5 score_lane. E6 C9/C10 scratch. S1 A7 filter. S2 #156-158 green. S3 measured quorum or 503. S4 extra cases #756. S5/S11 envelope exported on verify. S6 present_proof on packed tree. S8 README pin 1.3.0. S10 evaluate=verifyOutput alias. S12 local e2e:mvp on pack. #159 refuse eyJ fallback.

## CLOSED since this file was last written
#754 and #756 are merged/closed. Do not rebase them. Do not fold new work into those branches.
HYP-5 type-A inventory merged as #782. Ceiling is 4. Remainder is HYP-10 (wrap) then HYP-11 (LOCAL_LLM_BASE_URL).

## OPEN
F-PUBLISH — Sean: npm publish packed candidate after audit.
F-DDL — Sean: apply unique-on-evidence_id after reading SQL.
F-E2E-PUB — after publish, e2e:mvp against @latest.
F-LIVE-SETTLE — one production service_contracts row reaches settled.
F-STACK-GH — TrustShell stack exists on GitHub as one PR, not only local feat/xc2-2026-09-15-stack.
F-SITE — site version = published @latest after publish.
HYP-10 — XC1: wrap type-B CALLSITES 4 → 0 via providerFetch + PROVIDER_URLS. Draft only.
HYP-11 — blocked by HYP-10. Do not start on the wrap branch.
HYP-7 — freshness stall (#549 class). After wrap, diagnose draft only.
HYP-8 — register Map. Engine PR, not TrustShell UI. Avoid while #739 is open (same file).

Sean product holds (do not merge):
- #743 Together admission + live `/hal/evaluate` after recycle
- #739 cap 50 vs measured SERVICE_FULFILLED 364
- #749 delta bound vs #739

## Locks
XC1: HYP-10 wrap files only (`badges.ts`, `completeness.ts`, `adversarial-judge.ts`, `pcp-validator.ts` + guard ceiling). Never #743 / #739 / #749.
XC2: trustshell #153–155 only. Never engine scoring files. Never implement HYP-8 Redis in the UI repo.
