//! `zkpv` — a command-line front end over the ownership proof in this crate, so a script can
//! produce and check the evidence an ERC-8004 Validation Registry request carries.
//!
//! ```text
//! zkpv commit <secret> <agent_id>                        -> {"commitment":N}
//! zkpv nullifier <secret> <context>                      -> {"nullifier":N}
//! zkpv prove <secret> <agent_id> <context> <c0,c1,c2,c3> -> {"context","nullifier","group","proof"}
//! zkpv verify < {"context","nullifier","group","proof"}  -> {"ok":true|false,"error"?}
//! ```
//!
//! Exit codes: 0 done (or VERIFIED), 1 the proof was rejected, 2 bad input. The verifier learns
//! only `(context, nullifier, group)`: never the secret, never which member proved, never the
//! agent id behind the commitment. Soundness is this crate's (README: demo FRI parameters, a
//! 31-bit field); nothing here strengthens or weakens it.
use std::io::Read;
use std::process::ExitCode;

use p3_baby_bear::BabyBear;
use p3_field::{PrimeCharacteristicRing, PrimeField32};
use serde_json::{json, Value};
use zkp_vault::{commitment, nullifier, proof_from_bytes, proof_to_bytes, prove_ownership, verify_ownership, GROUP_SIZE};

fn bad(msg: &str) -> ExitCode {
    eprintln!("zkpv: {msg}");
    ExitCode::from(2)
}

fn parse_u64(s: &str) -> Option<u64> {
    s.trim().parse::<u64>().ok()
}

/// A group element must already be a canonical field element: a value at or above the modulus
/// would be silently reduced and stop matching the commitment it claims to be.
fn parse_group(items: &[u64]) -> Option<[BabyBear; GROUP_SIZE]> {
    if items.len() != GROUP_SIZE || items.iter().any(|&v| v >= u64::from(BabyBear::ORDER_U32)) {
        return None;
    }
    let mut g = [BabyBear::ZERO; GROUP_SIZE];
    for (slot, &v) in g.iter_mut().zip(items) {
        *slot = BabyBear::from_u64(v);
    }
    Some(g)
}

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(2 + bytes.len() * 2);
    s.push_str("0x");
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn from_hex(s: &str) -> Option<Vec<u8>> {
    let h = s.strip_prefix("0x")?;
    if h.len() % 2 != 0 {
        return None;
    }
    (0..h.len()).step_by(2).map(|i| u8::from_str_radix(&h[i..i + 2], 16).ok()).collect()
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("commit") if args.len() == 3 => match (parse_u64(&args[1]), parse_u64(&args[2])) {
            (Some(secret), Some(agent)) => {
                println!("{}", json!({ "commitment": commitment(secret, agent).as_canonical_u32() }));
                ExitCode::SUCCESS
            }
            _ => bad("commit <secret> <agent_id>: both must be unsigned integers"),
        },
        Some("nullifier") if args.len() == 3 => match (parse_u64(&args[1]), parse_u64(&args[2])) {
            (Some(secret), Some(context)) => {
                println!("{}", json!({ "nullifier": nullifier(secret, context).as_canonical_u32() }));
                ExitCode::SUCCESS
            }
            _ => bad("nullifier <secret> <context>: both must be unsigned integers"),
        },
        Some("prove") if args.len() == 5 => {
            let (Some(secret), Some(agent), Some(context)) = (parse_u64(&args[1]), parse_u64(&args[2]), parse_u64(&args[3])) else {
                return bad("prove <secret> <agent_id> <context> <c0,c1,c2,c3>");
            };
            let items: Option<Vec<u64>> = args[4].split(',').map(parse_u64).collect();
            let Some(group) = items.as_deref().and_then(parse_group) else {
                return bad("the group must be exactly 4 canonical field elements");
            };
            // The prover's own commitment must be in the group; a non-member cannot produce a
            // verifying proof (tests: non_member_is_unprovable), so refuse before trying.
            let own = commitment(secret, agent);
            if !group.contains(&own) {
                return bad("this secret and agent are not a member of the group");
            }
            let proof = prove_ownership(secret, agent, context, &group);
            println!(
                "{}",
                json!({
                    "context": context,
                    "nullifier": nullifier(secret, context).as_canonical_u32(),
                    "group": group.iter().map(|g| g.as_canonical_u32()).collect::<Vec<_>>(),
                    "proof": to_hex(&proof_to_bytes(&proof)),
                })
            );
            ExitCode::SUCCESS
        }
        Some("verify") if args.len() == 1 => {
            let mut input = String::new();
            if std::io::stdin().read_to_string(&mut input).is_err() {
                return bad("could not read stdin");
            }
            let Ok(v) = serde_json::from_str::<Value>(&input) else {
                return bad("stdin is not JSON");
            };
            let context = v["context"].as_u64();
            let null = v["nullifier"].as_u64().filter(|&n| n < u64::from(BabyBear::ORDER_U32));
            let items: Option<Vec<u64>> = v["group"].as_array().map(|a| a.iter().filter_map(Value::as_u64).collect());
            let group = items.as_deref().and_then(parse_group);
            let bytes = v["proof"].as_str().and_then(from_hex);
            let (Some(context), Some(null), Some(group), Some(bytes)) = (context, null, group, bytes) else {
                return bad("need context (u64), nullifier (field element), group (4 field elements), proof (0x hex)");
            };
            let Ok(proof) = proof_from_bytes(&bytes) else {
                println!("{}", json!({ "ok": false, "error": "proof bytes do not decode" }));
                return ExitCode::from(1);
            };
            match verify_ownership(&proof, context, BabyBear::from_u64(null), &group) {
                Ok(()) => {
                    println!("{}", json!({ "ok": true }));
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    println!("{}", json!({ "ok": false, "error": format!("{e:?}") }));
                    ExitCode::from(1)
                }
            }
        }
        _ => bad("usage: zkpv commit|nullifier|prove|verify (see src/bin/zkpv.rs)"),
    }
}
