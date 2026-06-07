# Custom STARK Salvage Memo

**Date:** 2026-06-06  
**Author:** Gemini (Antigravity pairs)  
**Task:** Track C (salvage-read)  
**Target Repository:** `hyperdag-platform`  
**Inspected Files:**  
- [`zkp-circuits/src/repid_air.rs`](file:///C:/Users/Cash4/repos/hyperdag-platform/zkp-circuits/src/repid_air.rs)
- [`zkp-circuits/src/repid_verifier.rs`](file:///C:/Users/Cash4/repos/hyperdag-platform/zkp-circuits/src/repid_verifier.rs)
- [`zkp-circuits/src/custom_stark.rs`](file:///C:/Users/Cash4/repos/hyperdag-platform/zkp-circuits/src/custom_stark.rs)

---

## 1. Executive Summary

This memo analyzes the ZK-STARK constraints and proving system implemented in the `hyperdag-platform` repository for RepID. The codebase contains **critical mathematical and logical bugs** that render the constraints unsound or mathematically broken in a real field setting. This memo details the port/drop/avoid recommendations for each constraint and component.

---

## 2. Plonky3 AIR Constraint Analysis (`repid_air.rs`)

### Constraint 1: Wallet Hash Consistency
* **Line Reference:** [repid_air.rs:74-76](file:///C:/Users/Cash4/repos/hyperdag-platform/zkp-circuits/src/repid_air.rs#L74-L76)
  ```rust
  if main.height() > 1 {
      builder.assert_eq(wallet_hash, next[0]);
  }
  ```
* **Verdict:** **PORT**
* **Rationale:** Correctly ensures that the user's wallet identity remains constant across all execution steps.

### Constraint 2: Timestamp Monotonicity
* **Line Reference:** [repid_air.rs:79-81](file:///C:/Users/Cash4/repos/hyperdag-platform/zkp-circuits/src/repid_air.rs#L79-L81)
  ```rust
  if main.height() > 1 {
      builder.assert_bool(next[1] - timestamp);
  }
  ```
* **Verdict:** **DROP / RE-WRITE**
* **Rationale:** `assert_bool(x)` constrains `x` to be in `{0, 1}`. Constraining the difference `next[1] - timestamp` to be boolean means timestamps can only increase by exactly 0 or 1. This prevents larger epoch increments. It must be replaced by a range check circuit using bit-decomposition.

### Constraint 3: Aggregated Score Calculation & Decay
* **Line Reference:** [repid_air.rs:93-103](file:///C:/Users/Cash4/repos/hyperdag-platform/zkp-circuits/src/repid_air.rs#L93-L103)
  ```rust
  let time_diff = timestamp - self.time_window;
  let decay_factor = time_diff * self.decay_rate / F::from_canonical_u32(10000);
  let decayed_score = builder.if_else(
      decay_applied,
      expected_score - decay_factor,
      expected_score
  );
  builder.assert_eq(aggregated_score, decayed_score);
  ```
* **Verdict:** **AVOID / RE-WRITE**
* **Rationale:** 
  1. `time_diff` will underflow and wrap around the field modulus if `timestamp < self.time_window`, resulting in a massive incorrect decay value.
  2. Because the condition `decay_applied` is derived via `timestamp - self.time_window` (see Constraint 7), the `if_else` selects the decayed path for all cases except when `timestamp` equals the window exactly. Range checks must be used instead.

### Constraint 4: Threshold Verification
* **Line Reference:** [repid_air.rs:107-115](file:///C:/Users/Cash4/repos/hyperdag-platform/zkp-circuits/src/repid_air.rs#L107-L115)
  ```rust
  builder.assert_bool(meets_threshold);
  let threshold_check = builder.if_else(
      aggregated_score - self.threshold,
      AB::Expr::one(),
      AB::Expr::zero()
  );
  builder.assert_eq(meets_threshold, threshold_check);
  ```
* **Verdict:** **AVOID (Broken Inequality)**
* **Rationale:** In field arithmetic, a value is either zero or non-zero. Using `aggregated_score - self.threshold` as a condition in `if_else` evaluates to true (non-zero) for *any* score not equal to the threshold. As a result, `meets_threshold` is set to `1` when the score is either greater *or* less than the threshold, and set to `0` only when the score equals the threshold exactly. This is mathematically broken and must be replaced by a proper ZK range-proof comparison.

### Constraint 5: Multiplicative Bonus
* **Line Reference:** [repid_air.rs:119-124](file:///C:/Users/Cash4/repos/hyperdag-platform/zkp-circuits/src/repid_air.rs#L119-L124)
  ```rust
  let num_active_categories = category_scores.iter()
      .map(|&score| builder.if_else(score, AB::Expr::one(), AB::Expr::zero()))
      .fold(AB::Expr::zero(), |acc, x| acc + x);
  ```
* **Verdict:** **PORT WITH CAUTION**
* **Rationale:** Correctly counts non-zero category scores. However, it relies on category scores being binary (see Constraint 6).

### Constraint 6: Category Scores Non-Negativity
* **Line Reference:** [repid_air.rs:126-129](file:///C:/Users/Cash4/repos/hyperdag-platform/zkp-circuits/src/repid_air.rs#L126-L129)
  ```rust
  for &score in &category_scores {
      builder.assert_bool(score); // This ensures score is in {0, 1, 2, ...}
  }
  ```
* **Verdict:** **DROP (Fatal Constraint Bug)**
* **Rationale:** The comment claims this ensures scores are non-negative. However, `assert_bool` constrains the value to exactly `0` or `1`. This restricts all category scores to binary values, breaking any multi-valued reputation system.

### Constraint 7: Decay Application Logic
* **Line Reference:** [repid_air.rs:131-139](file:///C:/Users/Cash4/repos/hyperdag-platform/zkp-circuits/src/repid_air.rs#L131-L139)
  ```rust
  builder.assert_bool(decay_applied);
  let decay_check = builder.if_else(
      timestamp - self.time_window,
      AB::Expr::one(),
      AB::Expr::zero()
  );
  builder.assert_eq(decay_applied, decay_check);
  ```
* **Verdict:** **AVOID**
* **Rationale:** Similar to Constraint 4, `timestamp - self.time_window` will evaluate to non-zero for any timestamp not exactly equal to the window limit. This means decay is erroneously applied to all steps except when `timestamp == time_window`.

---

## 3. Plonky3 Prover/Verifier Configurations (`repid_verifier.rs`)

### Critically Flawed Component: RNG-Seeded Poseidon2 Constants
* **Line Reference:** [repid_verifier.rs:34-37](file:///C:/Users/Cash4/repos/hyperdag-platform/zkp-circuits/src/repid_verifier.rs#L34-L37)
  ```rust
  let perm = Poseidon2::new_from_rng_128(
      Poseidon2ExternalMatrixGeneral,
      &mut rand::thread_rng()
  );
  ```
* **Verdict:** **DO NOT CARRY (Critical Failure)**
* **Rationale:** Instantiating the Poseidon2 permutation using `rand::thread_rng()` means MDS matrices and round constants are generated randomly at runtime. Provers and verifiers running in different threads, processes, or machines will generate different constants, making verification fail 100% of the time. 
* **Remediation:** Replace with static, hardcoded constants, or seed the generator with a deterministic, fixed seed.

---

## 4. Custom STARK Mathematical Engine (`custom_stark.rs`)

### Critically Flawed Component: Dummy LDE (Low-Degree Extension)
* **Line Reference:** [custom_stark.rs:500-507](file:///C:/Users/Cash4/repos/hyperdag-platform/zkp-circuits/src/custom_stark.rs#L500-L507)
  ```rust
  let base_value = trace.get(base_row, col);
  lde.set(row, col, base_value * interpolation_factor);
  ```
* **Verdict:** **DROP (Insecure Mock)**
* **Rationale:** LDE requires polynomial evaluation over a larger coset domain via FFT/iFFT to maintain low-degree proximity properties. Simple multiplication by `interpolation_factor` does not extend the polynomial degree constraints and violates the fundamental math behind STARK soundness.

### Critically Flawed Component: Dummy FRI Folding & Mock Merkle Paths
* **Line Reference:** [custom_stark.rs:531](file:///C:/Users/Cash4/repos/hyperdag-platform/zkp-circuits/src/custom_stark.rs#L531) and [custom_stark.rs:567-579](file:///C:/Users/Cash4/repos/hyperdag-platform/zkp-circuits/src/custom_stark.rs#L567-579)
  ```rust
  let final_poly = vec![BabyBearField::ONE; current_poly_size.min(8)];
  ```
* **Verdict:** **DROP**
* **Rationale:** The FRI implementation is a mock that commits to hardcoded constants and folds trivial sizes, while query paths hash index numbers instead of trace values. This offers zero cryptographic security.
