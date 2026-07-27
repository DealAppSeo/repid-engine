//! Parity/sanity gate for the Poseidon2-BabyBear 2-to-1 scalar-hash oracle (4.0-d.1).
//!
//! The oracle (`examples/poseidon2_2to1_kat.rs`) defines `H_p2(a,b) = Perm16([a,b,0..])[0]`
//! over `default_babybear_poseidon2_16()` (audited ground truth). These tests pin the
//! CONVENTION the in-AIR 4.0-d rewrite must reproduce: inputs in lanes 0,1; output lane 0;
//! zero padding. `H_p2` is definitionally the raw permutation's lane 0, so we cross-check
//! it against a raw permute computed independently here — the wrapper can't be subtly
//! wrong (wrong lane / wrong output index / non-zero padding) without a test failing.
//!
//! `h_p2` is imported from the crate, NOT re-declared here: the generator and this gate
//! share one definition, so this file validates the code that actually produced the
//! committed KAT. `committed_kat_json_matches_ground_truth` closes the remaining half of
//! that loop by checking the committed ARTIFACT against a locally computed raw permute.

use p3_baby_bear::{default_babybear_poseidon2_16, BabyBear};
use p3_field::PrimeField32;
use p3_symmetric::Permutation;
use zkp_vault::poseidon2_hash2::h_p2;

fn raw_permute(input: [u32; 16]) -> [u32; 16] {
    let perm = default_babybear_poseidon2_16();
    let mut state: [BabyBear; 16] = BabyBear::new_array(input);
    perm.permute_mut(&mut state);
    core::array::from_fn(|i| state[i].as_canonical_u32())
}

/// H_p2(a,b) must equal lane 0 of the raw permutation of [a, b, 0, 0, ...]. This pins
/// the exact convention (lanes 0,1 in; lane 0 out; zero padding) against the primitive.
#[test]
fn h_p2_equals_raw_permutation_lane0() {
    for (a, b) in [(0u32, 0u32), (1, 2), (777, 555), (123456789, 42), (2013265920, 0)] {
        let mut padded = [0u32; 16];
        padded[0] = a;
        padded[1] = b;
        assert_eq!(h_p2(a, b), raw_permute(padded)[0], "H_p2 convention drift for ({a},{b})");
    }
}

/// Pull the `(a, b, output)` triples out of the committed KAT JSON without a serde
/// dependency (the generator emits one field per line, so a line scan is exact).
fn parse_kat_vectors(json: &str) -> Vec<(u32, u32, u32)> {
    fn num(line: &str, key: &str) -> Option<u32> {
        line.strip_prefix(key)?
            .trim()
            .trim_end_matches(',')
            .trim()
            .parse::<u32>()
            .ok()
    }
    let mut vectors = Vec::new();
    let (mut a, mut b) = (None, None);
    for line in json.lines() {
        let line = line.trim();
        if let Some(v) = num(line, "\"a\":") {
            a = Some(v);
        } else if let Some(v) = num(line, "\"b\":") {
            b = Some(v);
        } else if let Some(out) = num(line, "\"output\":") {
            let a = a.take().expect("KAT vector has `output` before `a`");
            let b = b.take().expect("KAT vector has `output` before `b`");
            vectors.push((a, b, out));
        }
    }
    vectors
}

/// The committed KAT JSON is what the TypeScript gate (`tests/poseidon2-hash2.test.ts`,
/// 4.0-d.2) asserts against, so the ARTIFACT itself must be pinned to ground truth —
/// not just the function that writes it. Every committed vector is re-derived here from
/// a raw permutation, so a drifted or hand-edited KAT fails loudly instead of silently
/// re-defining the convention on both sides of the language boundary.
#[test]
fn committed_kat_json_matches_ground_truth() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/kat/poseidon2_babybear16_2to1_kat.json"
    );
    let json = std::fs::read_to_string(path).unwrap_or_else(|e| {
        panic!(
            "committed 2-to-1 KAT oracle unreadable at {path}: {e}\n\
             regenerate: cargo run --example poseidon2_2to1_kat --manifest-path zkp-vault/Cargo.toml \
             > zkp-vault/kat/poseidon2_babybear16_2to1_kat.json"
        )
    });
    let vectors = parse_kat_vectors(&json);
    assert_eq!(
        vectors.len(),
        8,
        "expected 8 committed KAT vectors, parsed {} — truncated or malformed oracle",
        vectors.len()
    );
    for (a, b, output) in vectors {
        let mut padded = [0u32; 16];
        padded[0] = a;
        padded[1] = b;
        assert_eq!(
            output,
            raw_permute(padded)[0],
            "committed KAT vector ({a},{b}) does not match the raw permutation — the oracle drifted"
        );
    }
}

/// The artifact's DECLARATIVE HEADER must be pinned too, not just its vectors.
///
/// Found by the Beat 26 verifier (2026-07-27): editing `field_prime` from 2013265921
/// to 2013265922 left all 21 tests green. The vector gate above recomputes outputs, so
/// it is blind to the header — yet the header is what a reader (and the TS port's
/// orientation comments) trust to say WHICH field and width these numbers live in. A
/// wrong `field_prime` in a committed cryptographic artifact is exactly the kind of
/// quiet falsehood that costs someone a day later.
///
/// The expected values are DERIVED from the audited primitive (`BabyBear`'s own modulus,
/// the permutation's own width), not retyped, so this cannot drift into a tautology.
#[test]
fn committed_kat_json_header_matches_the_primitive() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/kat/poseidon2_babybear16_2to1_kat.json"
    );
    let json = std::fs::read_to_string(path).expect("committed 2-to-1 KAT oracle unreadable");

    fn header_field<'a>(json: &'a str, key: &str) -> &'a str {
        json.lines()
            .map(str::trim)
            .find_map(|l| l.strip_prefix(key))
            .unwrap_or_else(|| panic!("committed KAT header is missing `{key}`"))
            .trim()
            .trim_end_matches(',')
            .trim()
            .trim_matches('"')
    }

    // Derived from the field itself — if p3 ever changed BabyBear's modulus this would
    // fail here rather than leave a stale constant sitting in a "known-answer" file.
    let expected_prime = <BabyBear as PrimeField32>::ORDER_U32;
    let declared_prime: u32 = header_field(&json, "\"field_prime\":")
        .parse()
        .expect("`field_prime` is not a u32");
    assert_eq!(
        declared_prime, expected_prime,
        "committed KAT declares field_prime {declared_prime}, but BabyBear's modulus is {expected_prime}"
    );

    // Derived from the permutation actually used to produce the vectors.
    let expected_width = raw_permute([0u32; 16]).len();
    let declared_width: usize = header_field(&json, "\"width\":")
        .parse()
        .expect("`width` is not a usize");
    assert_eq!(
        declared_width, expected_width,
        "committed KAT declares width {declared_width}, but the permutation is width {expected_width}"
    );

    assert_eq!(
        header_field(&json, "\"scheme\":"),
        "poseidon2_babybear16_2to1",
        "committed KAT scheme label changed — the TS gate keys its orientation off this string"
    );
}

/// Determinism: pure function of its two inputs.
#[test]
fn h_p2_is_deterministic() {
    assert_eq!(h_p2(777, 555), h_p2(777, 555));
    assert_eq!(h_p2(0, 0), h_p2(0, 0));
}

/// Scoped nullifier: same secret, distinct scopes -> distinct hashes
/// (ZKP_ARCHITECTURE_INVARIANTS Invariant 2 — the property the circuit relies on).
#[test]
fn h_p2_separates_scopes() {
    let secret = 999983u32;
    assert_ne!(h_p2(secret, 1), h_p2(secret, 2), "scope collapse");
    assert_ne!(h_p2(secret, 1), h_p2(secret, 3), "scope collapse");
}

/// Sanity: distinct inputs don't collapse; output is canonical (< p); argument order
/// matters (H_p2 is not symmetric).
#[test]
fn h_p2_is_nontrivial_canonical_and_ordered() {
    let p = 2013265921u32;
    let a = h_p2(0, 0);
    let b = h_p2(1, 0);
    let c = h_p2(0, 1);
    assert_ne!(a, b, "collapsed distinct inputs");
    assert_ne!(b, c, "H_p2 unexpectedly symmetric in (a,b)");
    for v in [a, b, c] {
        assert!(v < p, "output {v} not canonical");
    }
}
