# TrustRails Guardrail — Changelog

## 0.7.0 — 2026-06-25 (STAGED for publish; not yet published)
The 7 rounds of hardening, now in the installable package surface (previously local-only).
- **Sequence-aware `SessionGuard`** — thread one tracker across a chain and recon→credential /
  recon→destructive escalate even though each step alone is T0. **Catches the PocketOS chain**
  (scan codebase → read master token → destroy) at the credential step, from the package entry.
- **Hardened classifier** behind the existing `guard()` API (non-breaking):
  - canonicalization before matching (homoglyph / whitespace / git-ref prefix / SQL-comment),
    closing the round-4 string-evasion breaches (DDL in any kind, `origin/main`/`refs/heads/main`,
    prod-id-in-description).
  - aggregate spend cumulative + velocity cap (cost-splitting).
  - class-level **false-positive exemptions** (docs / tests / fixtures are reversible context),
    each with a paired attack proving a positive critical rule still dominates.
- **Tamper-evident decision trace** (hash-chained) + **fail-closed** everywhere + **rate-limiting**
  (a flood can't bury a T2 or exhaust the gate).
- **MITRE ATLAS / ATT&CK** coverage map exported (`RULE_ATLAS`, `SESSION_ATLAS`).
- Public API is additive: `guard()` shape unchanged; new `SessionGuard`, ATLAS maps re-exported.

## 0.1.0 — initial
- `guard(action) → { tier, verdict, reason, log }`, config surface, local decision-trace sink, CLI.
