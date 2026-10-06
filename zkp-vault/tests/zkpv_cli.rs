//! The `zkpv` command line, run as a stranger would run it: the built binary, JSON in and out.
//! Pins the four properties the ERC-8004 validation demo leans on (scripts/demo/human-backed-validation.ts):
//! a member's proof verifies, a tampered proof is rejected, a non-member cannot prove, and the same
//! human's nullifier differs per context but repeats within one.
use std::io::Write;
use std::process::{Command, Stdio};

fn zkpv(args: &[&str], stdin: Option<&str>) -> (i32, String) {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_zkpv"));
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::piped());
    let mut child = cmd.spawn().expect("zkpv runs");
    if let Some(input) = stdin {
        child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
    } else {
        drop(child.stdin.take());
    }
    let out = child.wait_with_output().unwrap();
    (out.status.code().unwrap_or(-1), String::from_utf8(out.stdout).unwrap())
}

fn field(json: &str, key: &str) -> serde_json::Value {
    serde_json::from_str::<serde_json::Value>(json).unwrap()[key].clone()
}

fn group() -> String {
    let members = [(11u64, 3747u64), (22, 6712), (33, 1), (44, 2)];
    members
        .iter()
        .map(|(s, a)| field(&zkpv(&["commit", &s.to_string(), &a.to_string()], None).1, "commitment").to_string())
        .collect::<Vec<_>>()
        .join(",")
}

#[test]
fn a_member_proves_and_the_proof_verifies() {
    let g = group();
    let (code, req) = zkpv(&["prove", "22", "6712", "777", &g], None);
    assert_eq!(code, 0);
    let (code, out) = zkpv(&["verify"], Some(&req));
    assert_eq!((code, field(&out, "ok")), (0, serde_json::json!(true)));
}

#[test]
fn a_changed_byte_is_rejected_with_exit_1() {
    let g = group();
    let (_, req) = zkpv(&["prove", "22", "6712", "777", &g], None);
    let mut v: serde_json::Value = serde_json::from_str(&req).unwrap();
    let p = v["proof"].as_str().unwrap().to_string();
    let i = p.len() / 2;
    let flipped = if &p[i..i + 1] == "0" { "1" } else { "0" };
    v["proof"] = serde_json::json!(format!("{}{}{}", &p[..i], flipped, &p[i + 1..]));
    let (code, out) = zkpv(&["verify"], Some(&v.to_string()));
    assert_eq!((code, field(&out, "ok")), (1, serde_json::json!(false)));
}

#[test]
fn the_wrong_context_or_nullifier_is_rejected() {
    let g = group();
    let (_, req) = zkpv(&["prove", "22", "6712", "777", &g], None);
    let mut v: serde_json::Value = serde_json::from_str(&req).unwrap();
    v["context"] = serde_json::json!(778);
    assert_eq!(zkpv(&["verify"], Some(&v.to_string())).0, 1);
}

#[test]
fn a_non_member_cannot_prove() {
    let (code, out) = zkpv(&["prove", "99", "6712", "777", &group()], None);
    assert_eq!((code, out.as_str()), (2, ""));
}

#[test]
fn nullifiers_differ_across_contexts_and_repeat_within_one() {
    let a = field(&zkpv(&["nullifier", "22", "777"], None).1, "nullifier");
    let b = field(&zkpv(&["nullifier", "22", "778"], None).1, "nullifier");
    let again = field(&zkpv(&["nullifier", "22", "777"], None).1, "nullifier");
    assert_ne!(a, b);
    assert_eq!(a, again);
}

#[test]
fn malformed_input_is_exit_2_never_a_verdict() {
    assert_eq!(zkpv(&["verify"], Some("not json")).0, 2);
    assert_eq!(zkpv(&["verify"], Some(r#"{"context":1,"nullifier":1,"group":[1,2,3],"proof":"0x00"}"#)).0, 2);
    assert_eq!(zkpv(&["prove", "1", "2", "3", "1,2,3,4294967295"], None).0, 2);
}
