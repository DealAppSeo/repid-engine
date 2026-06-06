//! zkp-vault prover + x402 gate HTTP service (SPRINT_CC_3 P2 + P4).
//!
//!   GET  /health
//!   POST /prove/ownership   {"secret","agent_id","context"}
//!   POST /prove/tier_range  {"score","threshold"}                 (proves score >= threshold)
//!   POST /prove/disclosure  {"earned","perceived","x","band"}     (earned>=x AND perceived<=earned+band)
//!   POST /x402/gated        {"proof_bytes": hex, "x","band","amount"}
//!        -> 200 if the disclosure proof satisfies (x,band): x402 access granted (settlement
//!           stubbed on testnet — facilitator not wired); -> 402 Payment Required otherwise.
//!        The gate sees ONLY the proof + policy — never earned/perceived.
//!
//! Run:  PROVER_ADDR=127.0.0.1:8645 cargo run --release --bin prover

use tiny_http::{Header, Method, Response, Server};
use zkp_vault::selective_disclosure::{prove_band, verify_band};
use zkp_vault::{commitment, nullifier, proof_from_bytes, proof_to_bytes, prove_ownership, verify_ownership};

fn hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push_str(&format!("{:02x}", x));
    }
    s
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

fn handle(method: &Method, path: &str, body: &str) -> (u16, String) {
    if matches!(method, Method::Get) && path == "/health" {
        return (200, serde_json::json!({"ok": true, "service": "zkp-vault-prover"}).to_string());
    }
    if !matches!(method, Method::Post) {
        return (405, serde_json::json!({"ok": false, "error": "use POST"}).to_string());
    }
    let v: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return (400, serde_json::json!({"ok": false, "error": format!("bad json: {e}")}).to_string()),
    };
    let getu = |k: &str| v.get(k).and_then(|x| x.as_u64());

    match path {
        "/prove/ownership" => {
            let (secret, agent_id, context) = match (getu("secret"), getu("agent_id"), getu("context")) {
                (Some(a), Some(b), Some(c)) => (a, b, c),
                _ => return (400, serde_json::json!({"ok": false, "error": "need secret, agent_id, context"}).to_string()),
            };
            let group = [commitment(secret, agent_id), commitment(1, 1), commitment(2, 2), commitment(3, 3)];
            let proof = prove_ownership(secret, agent_id, context, &group);
            let n = nullifier(secret, context);
            let verified = verify_ownership(&proof, context, n, &group).is_ok();
            let bytes = proof_to_bytes(&proof);
            (if verified { 200 } else { 500 }, serde_json::json!({
                "ok": verified, "statement": "anonymous-ownership", "context": context,
                "nullifier": format!("{:?}", n), "proof_bytes": hex(&bytes), "proof_len": bytes.len(), "verified": verified
            }).to_string())
        }
        "/prove/tier_range" => {
            let (score, threshold) = match (getu("score"), getu("threshold")) {
                (Some(a), Some(b)) => (a as u32, b as u32),
                _ => return (400, serde_json::json!({"ok": false, "error": "need score, threshold"}).to_string()),
            };
            let proof = prove_band(score, score, threshold, 0);
            let verified = verify_band(&proof, threshold, 0).is_ok();
            let bytes = proof_to_bytes(&proof);
            (if verified { 200 } else { 500 }, serde_json::json!({
                "ok": verified, "statement": "tier-range (score >= threshold)", "threshold": threshold,
                "proof_bytes": hex(&bytes), "proof_len": bytes.len(), "verified": verified
            }).to_string())
        }
        "/prove/disclosure" => {
            let (earned, perceived, x, band) = match (getu("earned"), getu("perceived"), getu("x"), getu("band")) {
                (Some(a), Some(b), Some(c), Some(d)) => (a as u32, b as u32, c as u32, d as u32),
                _ => return (400, serde_json::json!({"ok": false, "error": "need earned, perceived, x, band"}).to_string()),
            };
            let proof = prove_band(earned, perceived, x, band);
            let verified = verify_band(&proof, x, band).is_ok();
            let bytes = proof_to_bytes(&proof);
            (if verified { 200 } else { 500 }, serde_json::json!({
                "ok": verified, "statement": "earned>=x AND perceived<=earned+band", "x": x, "band": band,
                "proof_bytes": hex(&bytes), "proof_len": bytes.len(), "verified": verified
            }).to_string())
        }
        "/x402/gated" => {
            // x402-gated selective disclosure: a paid call unlocked by a ZK proof,
            // revealing NO values. Gate sees only (proof, x, band).
            let proof_hex = match v.get("proof_bytes").and_then(|x| x.as_str()) {
                Some(s) => s,
                None => return (400, serde_json::json!({"ok": false, "error": "need proof_bytes (hex)"}).to_string()),
            };
            let (x, band) = match (getu("x"), getu("band")) {
                (Some(a), Some(b)) => (a as u32, b as u32),
                _ => return (400, serde_json::json!({"ok": false, "error": "need x, band"}).to_string()),
            };
            let amount = getu("amount").unwrap_or(0);
            let proof = match unhex(proof_hex).and_then(|b| proof_from_bytes(&b).ok()) {
                Some(p) => p,
                None => return (402, serde_json::json!({"ok": false, "x402": "payment_required", "error": "unreadable proof"}).to_string()),
            };
            if verify_band(&proof, x, band).is_ok() {
                // GRANTED. Real x402 settlement (USDC via facilitator on Base Sepolia) is
                // stubbed here — the novel part (ZK proof unlocks the paid call without
                // revealing earned/perceived) is fully real.
                (200, serde_json::json!({
                    "ok": true, "x402": "settled", "policy": {"x": x, "band": band}, "amount": amount,
                    "access": "granted", "settlement": "stubbed-testnet",
                    "note": "disclosure proof satisfied policy; no values revealed"
                }).to_string())
            } else {
                (402, serde_json::json!({
                    "ok": false, "x402": "payment_required", "policy": {"x": x, "band": band},
                    "error": "disclosure proof did not satisfy policy (under-threshold or unhealthy gap)"
                }).to_string())
            }
        }
        _ => (404, serde_json::json!({"ok": false, "error": "unknown path"}).to_string()),
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
        use std::io::Read;
        let _ = req.as_reader().read_to_string(&mut body);
        let (status, json) = handle(&method, &path, &body);
        let header = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
        let _ = req.respond(Response::from_string(json).with_status_code(status).with_header(header));
    }
}
