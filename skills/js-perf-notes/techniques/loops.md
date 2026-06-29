# Loop body: hoisting, specialization, cheap substitutions

Techniques for when the bottleneck is **compute inside a hot loop**. These are
loop-body transforms — apply them only inside a loop the profiler actually
flagged, not preemptively.

## Hoist invariants and decisions out of the loop

- Lift the type/branch/config decision *above* the loop and emit a specialized
  loop body, instead of re-deciding every iteration.
- Hoist repeated property-chain reads into locals before the loop
  (`const items = this.state.items`). Repeated `this.a.b.c` in a hot loop is
  repeated lookups.

## Specialize the common shapes

- Branch once on the dominant case (a fixed small size, the common type, the
  default config) and write a fully unrolled, simplified version for it. Removes
  inner-loop bookkeeping and dispatch.
- Keep a general fallback for the rare shapes — specialize the 90% case, don't
  rewrite the whole matrix.

## Cheap substitutions — only in proven hot paths

- Micro-level rewrites (bit ops over arithmetic, `(x / n) | 0` over
  `Math.floor` for non-negative values below 2³¹, indexing a precomputed array
  over recomputing) are real but small. Reach for them only inside a loop the
  profiler actually flagged; elsewhere they just cost readability.
- Watch for subtle semantic shifts when rewriting numeric or boundary logic
  (overflow, rounding, sign, off-by-one). `| 0` truncates toward zero where
  `Math.floor` rounds toward −∞, and wraps above 2³¹ — a faster line that
  changes results is not an optimization, which is what the safety net (#1 in
  SKILL.md) is for.
- **Two of these substitutions are *not* small when they're per-element in a hot
  loop — they're often the tallest bar:**
  - **Calls into library / transcendental math.** `x ** n`, `Math.pow`,
    `Math.hypot`, `Math.exp` per element cost far more than they look — replace
    with a lookup table or expanded arithmetic
    (`Math.hypot(x,y,z)` → `Math.sqrt(x*x+y*y+z*z)`, a small integer exponent →
    a precomputed table). These hide because they read as one innocent call.
  - **Data-dependent branches cost via *misprediction*, not instruction count.**
    A branchless rewrite of a hot-loop branch can be a major win when the branch
    outcome depends on data the CPU can't predict — not because it saved an op.
    When the branch is predictable, the same rewrite buys nothing; the win is the
    misprediction, so reach for it only where the condition is genuinely random.
