//! zkp-vault prover HTTP service (SPRINT_CC_3 P2).
//!
//! Exposes the real Rust prover behind the TS bridge (`plonky3-real.ts`,
//! `PLONKY3_PROVER_URL`). Each endpoint PROVES then self-VERIFIES before responding,
//! so a caller always receives a verifying proof (or `ok:false`).
//!
//!   GET  /health
//!   POST /prove/ownership   {"secret":u64,"agent_id":u64,"context":u64}
//!   POST /prove/tier_range  {"score":u64,"threshold":u64}   (proves score >= threshold)
//!
//! Run:  PROVER_ADDR=127.0.0.1:8645 cargo run --release --bin prover
//! Test: curl -s -XPOST localhost:8645/prove/ownership -d '{"secret":777,"agent_id":555,"context":9001}'

use std::io::Read;
use tiny_http::{Header, Method, Response, Server};
use zkp_vault::selective_disclosure::{prove_band, verify_band};
use zkp_vault::{commitment, nullifier, proof_to_bytes, prove_ownership, verify_ownership};

fn hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push_str(&format!("{:02x}", x));
    }
    s
}

fn handle(method: &Method, path: &str, body: &str) -> String {
    if matches!(method, Method::Get) && path == "/health" {
        return serde_json::json!({"ok": true, "service": "zkp-vault-prover"}).to_string();
    }
    if !matches!(method, Method::Post) {
        return serde_json::json!({"ok": false, "error": "use POST"}).to_string();
    }
    let v: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return serde_json::json!({"ok": false, "error": format!("bad json: {e}")}).to_string(),
    };
    let getu = |k: &str| v.get(k).and_then(|x| x.as_u64());

    match path {
        "/prove/ownership" => {
            let (secret, agent_id, context) =
                match (getu("secret"), getu("agent_id"), getu("context")) {
                    (Some(a), Some(b), Some(c)) => (a, b, c),
                    _ => {
                        return serde_json::json!({"ok": false, "error": "need secret, agent_id, context"})
                            .to_string()
                    }
                };
            // Demo group containing this owner (production: real registered group).
            let group = [
                commitment(secret, agent_id),
                commitment(1, 1),
                commitment(2, 2),
                commitment(3, 3),
            ];
            let proof = prove_ownership(secret, agent_id, context, &group);
            let n = nullifier(secret, context);
            let verified = verify_ownership(&proof, context, n, &group).is_ok();
            let bytes = proof_to_bytes(&proof);
            serde_json::json!({
                "ok": verified,
                "statement": "anonymous-ownership",
                "context": context,
                "nullifier": format!("{:?}", n),
                "proof_bytes": hex(&bytes),
                "proof_len": bytes.len(),
                "verified": verified
            })
            .to_string()
        }
        "/prove/tier_range" => {
            // Threshold proof: prove score >= threshold WITHOUT revealing score.
            // Uses the selective-disclosure circuit with band=0 (perceived=earned=score).
            let (score, threshold) = match (getu("score"), getu("threshold")) {
                (Some(a), Some(b)) => (a as u32, b as u32),
                _ => {
                    return serde_json::json!({"ok": false, "error": "need score, threshold"})
                        .to_string()
                }
            };
            let proof = prove_band(score, score, threshold, 0);
            let verified = verify_band(&proof, threshold, 0).is_ok();
            let bytes = proof_to_bytes(&proof);
            serde_json::json!({
                "ok": verified,
                "statement": "tier-range (score >= threshold)",
                "threshold": threshold,
                "proof_bytes": hex(&bytes),
                "proof_len": bytes.len(),
                "verified": verified
            })
            .to_string()
        }
        _ => serde_json::json!({"ok": false, "error": "unknown path"}).to_string(),
    }
}

fn main() {
    let addr = std::env::var("PROVER_ADDR").unwrap_or_else(|_| "127.0.0.1:8645".into());
    let server = Server::http(&addr).expect("bind prover");
    eprintln!("zkp-vault prover listening on http://{addr}");
    for mut req in server.incoming_requests() {
        let method = req.method().clone();
        let path = req.url().to_string();
        let mut body = String::new();
        let _ = req.as_reader().read_to_string(&mut body);
        let json = handle(&method, &path, &body);
        let header = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
        let _ = req.respond(Response::from_string(json).with_header(header));
    }
}
