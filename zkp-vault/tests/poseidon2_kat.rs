//! # Poseidon2-BabyBear KAT parity gate (backlog 4.0-a)
//!
//! Three checks that turn the `examples/poseidon2_kat` oracle into a regression
//! gate and, crucially, prove the harness calls p3-poseidon2 *correctly*:
//!
//! 1. `published_rng_vector_reproduces` — reproduces p3-poseidon2 0.3.0's OWN
//!    published width-16 test vector (`test_poseidon2_width_16_random`) using the
//!    identical constructor + PRNG (`new_from_rng_128` over `Xoroshiro128Plus`
//!    seed 1). This is the INDEPENDENT ground truth: if our `new_array` →
//!    `permute_mut` → `as_canonical_u32` plumbing were wrong, this documented
//!    expected output would not reproduce. It validates the harness against
//!    Plonky3's own audited value, not against itself.
//!
//! 2. `default_constants_kat_frozen` — freezes the canonical
//!    `default_babybear_poseidon2_16()` (published Horizen-Labs constants) outputs
//!    for the 4 fixed inputs. These are THE oracle vectors the TypeScript port
//!    (4.0-b) must reproduce element-for-element. Committed so the oracle is
//!    reproducible and any future p3 bump that changes them fails loudly.
//!
//! 3. `default_differs_from_rng` — sanity: the published-constants instance and
//!    the rng-constants instance are genuinely different permutations (guards
//!    against accidentally testing the wrong instance).
//!
//! Run: `cargo test --manifest-path zkp-vault/Cargo.toml --test poseidon2_kat`

use p3_baby_bear::{default_babybear_poseidon2_16, BabyBear, Poseidon2BabyBear};
use p3_field::PrimeField32;
use p3_symmetric::Permutation;
use rand::SeedableRng;
use rand_xoshiro::Xoroshiro128Plus;

/// Permute a u32 input vector with the canonical published-constants instance.
fn permute_default(input_u32: [u32; 16]) -> [u32; 16] {
    let perm = default_babybear_poseidon2_16();
    let mut state: [BabyBear; 16] = BabyBear::new_array(input_u32);
    perm.permute_mut(&mut state);
    to_u32(&state)
}

fn to_u32(state: &[BabyBear; 16]) -> [u32; 16] {
    let mut out = [0u32; 16];
    for (i, e) in state.iter().enumerate() {
        out[i] = e.as_canonical_u32();
    }
    out
}

/// CHECK 1 — reproduce p3-poseidon2 0.3.0's own published width-16 KAT.
/// Values copied verbatim from `p3-baby-bear-0.3.0/src/poseidon2.rs`
/// `test_poseidon2_width_16_random` (input + expected). Constructing the same
/// instance the crate documents (`new_from_rng_128` over `Xoroshiro128Plus`
/// seed 1) must yield the crate's documented `expected`.
#[test]
fn published_rng_vector_reproduces() {
    let input_u32: [u32; 16] = [
        894848333, 1437655012, 1200606629, 1690012884, 71131202, 1749206695, 1717947831,
        120589055, 19776022, 42382981, 1831865506, 724844064, 171220207, 1299207443, 227047920,
        1783754913,
    ];
    let expected: [u32; 16] = [
        1255099308, 941729227, 93609187, 112406640, 492658670, 1824768948, 812517469, 1055381989,
        670973674, 1407235524, 891397172, 1003245378, 1381303998, 1564172645, 1399931635,
        1005462965,
    ];

    let mut rng = Xoroshiro128Plus::seed_from_u64(1);
    let perm = Poseidon2BabyBear::<16>::new_from_rng_128(&mut rng);
    let mut state: [BabyBear; 16] = BabyBear::new_array(input_u32);
    perm.permute_mut(&mut state);

    assert_eq!(
        to_u32(&state),
        expected,
        "harness does NOT reproduce p3-poseidon2's own published width-16 vector — \
         the new_array/permute_mut/as_canonical_u32 plumbing is wrong, oracle invalid"
    );
}

/// CHECK 2 — the frozen canonical oracle (published Horizen-Labs constants).
/// If any of these change, either p3 changed its constants or the harness broke;
/// either way a from-scratch TS port validated against the old vectors is now
/// invalid. These MUST match `examples/poseidon2_kat` output and the committed
/// `kat/poseidon2_babybear16_kat.json`.
#[test]
fn default_constants_kat_frozen() {
    let cases: [([u32; 16], [u32; 16]); 4] = [
        // zeros
        (
            [0; 16],
            [
                1168947398, 128782440, 747404447, 883925857, 360581875, 1704698758, 1878363991,
                1054281681, 682225194, 705839125, 1218819873, 41544645, 1095344608, 174996601,
                1678438226, 11259290,
            ],
        ),
        // iota 0..15
        (
            [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
            [
                1906786279, 1737026427, 1959749225, 700325316, 1638050605, 1021608788, 1726691001,
                1761127344, 1552405120, 417318995, 36799261, 1215172152, 614923223, 1300746575,
                957311597, 304856115,
            ],
        ),
        // ones
        (
            [1; 16],
            [
                1607442146, 1676863504, 74171774, 1027473481, 903407411, 908950222, 104477602,
                2007030265, 446104774, 602432596, 534407330, 1149883704, 1005849640, 1234792612,
                1595133452, 176734963,
            ],
        ),
        // leaf-shaped [secret=777, agent_id=555, 0..]
        (
            [777, 555, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            [
                422725277, 1581034804, 1057071425, 346283028, 136171787, 85690020, 1217386996,
                1125229924, 1977276789, 290529933, 792620854, 1998043765, 1814053164, 452246913,
                1805057740, 106202400,
            ],
        ),
    ];

    for (input, expected) in cases.iter() {
        assert_eq!(
            permute_default(*input),
            *expected,
            "frozen Poseidon2-BabyBear16 KAT drifted for input {:?}",
            input
        );
    }
}

/// CHECK 3 — the published-constants instance and the rng-constants instance
/// must genuinely differ (guards against testing the wrong instance).
#[test]
fn default_differs_from_rng() {
    let input_u32: [u32; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

    let default_out = permute_default(input_u32);

    let mut rng = Xoroshiro128Plus::seed_from_u64(1);
    let rng_perm = Poseidon2BabyBear::<16>::new_from_rng_128(&mut rng);
    let mut state: [BabyBear; 16] = BabyBear::new_array(input_u32);
    rng_perm.permute_mut(&mut state);

    assert_ne!(
        default_out,
        to_u32(&state),
        "published-constants and rng-constants instances produced identical output — \
         one of them is not the instance intended"
    );
}
