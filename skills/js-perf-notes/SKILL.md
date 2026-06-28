---
name: js-perf-notes
description: Optimize, speed up, profile, benchmark, or investigate CPU-bound JS/TS performance regressions in hot loops, algorithms, data structures, parsers, numeric/graphics code. Covers V8-level technique and noise-robust measurement; not browser/framework perf (DOM, React, page-load).
---

# JavaScript performance optimization — transferable principles

**When this skill is invoked, apply the principles below for the rest of the
performance-optimization work in this session** — let them guide how you profile,
what you change, and how you measure. If no target was given alongside the
invocation (no file, function, diff, or profile to work on), ask what to optimize
before proceeding; don't summarize this document back to the user.

**Scope:** this is about **CPU-bound** JavaScript/TypeScript — hot loops,
algorithms, data structures, parsers, numeric/geometry/graphics kernels — where a
profiler points at a function doing actual computation. It is *not* about
DOM/layout/rendering, React re-renders or memoization, bundle size, hydration, or
network/page-load latency; those are dominated by the browser and framework, and
the V8-level technique here won't move them. If the slowness is there, say so
rather than misapplying these notes.

This is a **reference to consult**, not a procedure to run start-to-finish. The
short "The loop" section below is the only sequential part; everything after it
is keyed by topic — jump to the section the task is about (profiling, V8
dispatch/inlining, memory layout, benchmarking, reporting). The principles are
calibrated against V8; re-verify on other engines (see the note before #4).

## The loop

Every optimization session is the same cycle:

1. **Profile** the real workload (see #3 for tooling).
2. **Hypothesize** from the profile — not from reading the code (#2).
3. **Change one thing.**
4. **Verify correctness** against the safety net (#0).
5. **Measure** against noise (#11), then keep or revert — never skip this and
   claim the win anyway; "should be faster" is a hypothesis, not a result.
6. **Re-profile before the next change.** The distribution shifts after every
   kept win; a stale profile sends you chasing bars that no longer exist.

## 0. Make change safe before you make it fast

Before optimizing, decide how you'll confirm behavior didn't change — and make
that check trustworthy and fast enough to run after every edit.

- A regression net you trust lets you **refactor boldly**. Without one you stay
  timid, making only the small changes you can eyeball — which are rarely the
  big wins.
- Prefer verifying against an **independent source of truth** (a known-good
  output set, a reference implementation, a property the result must satisfy)
  over "matches what it did yesterday." The former can also catch bugs that were
  already there; the latter just freezes whatever you started with.
- The time spent building the check is almost always repaid by the optimizations
  it unlocks. Build it first.

## 1. Tallest bars first, then the aggregate

Attack the highest *self-time* functions first — then switch to sweeping the
whole distribution once the obvious peaks are gone.

- **First pass: the peaks.** A tall bar is often a *blunder* — an accidental
  O(n²), redundant work repeated in a loop, a pathological allocation, a call
  that shouldn't be on the hot path at all. These are frequently one-line fixes
  for outsized wins, and they're the right thing to chase first.
- **Diminishing returns flip the strategy.** Once the peaks are shaved (or on a
  codebase already through earlier optimization passes), the tallest bar is a
  genuine, irreducible cost, not a mistake. Now total runtime is spread across
  many medium-cost functions, and the leverage moves to a *technique applied
  across the whole distribution* rather than a deeper assault on line 1.
- Know which regime you're in. The mistake is staying in peak-sniping mode after
  the peaks are real costs — or, conversely, reaching for a broad sweep before
  you've cleared the cheap blunders. Read the profile as a distribution and ask
  which one it's telling you. In the flattened regime especially, beware tunnel
  vision on one clever idea when a dull mechanical technique applied broadly
  wins more.
- **Question the algorithm before sweeping mechanically.** Is the data structure
  right for the workload's actual access pattern? Is there a known algorithm
  with better complexity or constants for this problem shape? Loop-level polish
  can't recover what a wrong algorithm gives away. And when no JS-level change
  suffices, ask whether the work belongs in this layer at all: precompute
  offline, cache at a higher level, or drop the kernel to WASM/SIMD.

## 2. Read the profile, not your cost model

The profile is the authority; your static reading of the code is a hypothesis.

- **Don't trust an a-priori cost ranking — profile the real workload first.** A
  careful static reading of the code can confidently invert the truth: the path
  that looks algorithmically expensive may be a tiny fraction of real time while
  some "incidental" post-processing step dominates. The up-front guess is for
  enumerating *candidates*, not ranking them; let the profile rank.
- **Self-time is reported *after* inlining.** The engine folds small helpers into
  their callers, so a tall self-time bar may actually be inlined callees doing the
  work — and a helper that looks cheap may be hot everywhere it gets inlined. Before
  acting on a bar, drop to line-level / position ticks to confirm what's actually
  executing there. (Seen: a function at 17% self-time whose cost was an inlined sort,
  while the sort's own frame read 2.7%.)
- **Group by a domain-meaningful dimension *and* read per-line — they answer
  different questions.** Per-group (by input type/config/size) tells you which
  *workload* dominates; per-line tells you which *code* executes most. They
  disagree when a hot line cross-cuts groups: the per-group view blames one
  category while a single line running across *all* of them is the real peak.
  Reconcile both before acting.
- **Counter-first on algorithmic ideas — instrument the domain counts before
  prototyping.** A profile tells you where *time* goes; before building a
  structural change, quantify the *premise* it rests on with a cheap counter:
  the prune rate the new index would buy, the fraction of iterations actually
  wasted, the composition of the candidate set you mean to filter. A false
  premise dies for free this way — no code written. (Seen: a "skip wasted
  rescans" idea where the counter showed 99.8% of iterations were wasted, which
  *confirmed* it; and a tie-break idea where the counter showed the candidate
  set it would reorder was empty — every selection came from an earlier
  early-return — which killed it before a line was written.) The profile ranks
  the code you have; counters test the code you're about to write.

## 3. Capturing evidence: the profiling toolkit

How to actually get the profile and confirm hypotheses, headlessly.

- **Primary tool: `flamebearer`** — summarizes Chrome DevTools traces
  (`.json` / `.json.gz`) and Node `.cpuprofile` files as a compact text report:
  top self-time functions per thread, long tasks, category breakdown. First
  check whether `flamebearer` / `flamebearer-node` already exist or are provided
  by repo-local tooling; only install them with user approval if needed
  (`npm install -g flamebearer`).

  ```bash
  flamebearer-node bench.js            # profile a script + report in one step
  flamebearer-node bench.js -- --top 30 --stacks quickselect
  flamebearer profile.json.gz          # analyze an existing Chrome trace
  flamebearer CPU.*.cpuprofile         # one or more Node profiles, or a folder
  ```

  Use `--stacks <fn>` to drill into a flagged function: callers, callees,
  dominant descendant path, and **hot source lines with self time per line,
  including inlined code** — this is how you do the line-level confirmation #2
  demands before acting on a tall bar. `--from`/`--to` restrict the time range
  (e.g. to skip warmup); `--thread` filters threads.
- **No tool dependency on the analysis itself.** flamebearer is just a headless
  text summarizer; the profile it reads is standard. `node --cpu-prof bench.js`
  emits a `.cpuprofile` you can open in Chrome DevTools (Performance → Load
  profile) instead, and the principles below hold for any sampling profiler. Use
  whatever's at hand — the discipline (#1, #2) matters more than the tool.
- **Confirm deopts directly, don't infer them.** `node --trace-deopt bench.js
  2>&1 | grep <fn>` shows whether a hot function is being kicked back to
  baseline, and the bailout reason names the unstable type or field.
  `--trace-ic` surfaces megamorphic call/property sites (look for `N`-marked
  state transitions) — evidence for #4's dispatch hypotheses.
- **Check tiering directly when in doubt:** run with `--allow-natives-syntax`
  and call `%GetOptimizationStatus(fn)` after warmup to see whether the
  function actually reached the optimizing tier.
- A sampling profile answers *where time goes*; the trace flags answer *why the
  engine couldn't make it fast*. They're complementary — get both before a
  non-obvious rewrite.

---

The techniques that follow are calibrated against V8 wherever they cite
engine-level specifics — SMI ranges, inlining budgets, shape monomorphism.
Other engines (JSC, SpiderMonkey) share the broad principles but differ in
details; if the code targets browsers, re-verify wins there rather than
asserting V8 behavior as universal JS truth.

## 4. Kill polymorphic / megamorphic dispatch in hot loops

Often the highest-leverage *mechanical* technique.

- Calls through an object whose shape varies (multiple subclasses, optional
  callbacks, plugin/strategy objects) become call sites the engine won't inline.
  In a hot loop that's a real per-iteration cost.
- **Large functions don't get inlined.** A hot loop inside a function bigger than
  the engine's inlining budget keeps calling its tiny helpers as real,
  un-inlined calls — those can be a sizable fraction of total time even though
  each looks trivial. Manually inline the helper bodies into the hot loop.
- **The inline budget is cumulative *per caller*, so identical call sites can
  inline or not depending on position.** V8 spends a fixed bytecode budget
  (~920) inlining into a given function; in a large function with several calls
  to the same small helper, the early sites inline and the later ones, once the
  budget is spent, stay real calls — so the same helper shows up hot at only
  *some* of its call sites. Confirm with `--trace-turbo-inlining` (and prove it
  by temporarily raising `--max-inlined-bytecode-size*`: the un-inlined version
  catches up). The fix is **inline arithmetic, not another helper** — expanding
  the call into plain expressions costs zero inline budget, whereas extracting
  the body to a new function just moves the boundary. (Seen: replacing a
  point-in-triangle *call* with its arithmetic at four z-walk sites, −3%; the
  earlier attempt that inlined only a guard but still *called* a larger helper
  did nothing.)
- Hoist the concrete leaf object out of a dispatch chain: if `a.doX()` just
  forwards to `this.impl.x()`, grab `impl` once and call it directly in the loop.
- Keep objects monomorphic — initialize all fields in the constructor in the same
  order, so the engine sees one consistent shape.
- **Watch for deopts, not just un-optimized code.** A hot function can be
  optimized and then kicked back to baseline mid-run by *type* instability — a
  field or loop variable that switches between int and double, a number that
  overflows into a float, reading `arguments`. Keep the types a hot path sees
  stable, not just the object shapes.

## 5. Use typed arrays; avoid per-iteration allocation

- Replace a JS `Array` used as a stack/buffer with a **preallocated typed array
  + a manual size counter** (`arr[size++] = x` / `size--`). Eliminates push/pop
  overhead and GC pressure. Size it to a known upper bound up front.
- **Measure GC% before chasing allocation at all.** "Reduce GC pressure" is a
  reflex that's often aimed at a non-problem — confirm GC is a real slice of the
  profile first. A whole-representation rewrite motivated by GC relief is wasted
  if GC was already <1% (seen: a flat-node rewrite premised on GC, where GC
  measured 0.1–0.6% — the premise was false before the work started).
- Boolean arrays → `Uint8Array`. Integer id/index arrays → `Int32Array` /
  `Uint32Array`. Smaller, contiguous, no boxing.
- **Keep hot-loop integer values in SMI range** (`[-2³¹, 2³¹)` on 64-bit V8).
  A value that exceeds it (e.g. a full unsigned 32-bit key, `>>> 0`, which reaches
  2³²−1) reads back from the array as a *float64*, so every comparison in a sort /
  merge / scan hot loop is a double compare, not a tagged-int one. This needn't be a
  deopt — the function stays optimized — yet it was a steady ~7% on an insert-heavy
  build just from the compare path. Prefer a `Uint32Array` over a JS array either
  way (no boxing at rest), but when the values are *compared* hot, get them into SMI
  range. If you need the full 32 bits of precision, **bias by −2³¹ and store in an
  `Int32Array`**: subtracting a constant is monotonic so any ordering is preserved,
  and the whole signed-32 range is SMI. Full precision *and* tagged-int compares,
  for one subtraction. (Seen in both RBush and Supercluster on Hilbert keys.)
- Don't allocate a temporary object/array per iteration just to return or pass a
  few values. Read or write the fields directly.
- Cache reusable views/buffers rather than reconstructing them each call — but
  invalidate the cache when the thing it's derived from changes identity.
- **Eliminate whole intermediate passes, not just per-iteration allocations.** A
  producer→scratch→consumer shape (write results into a temp buffer, then re-read
  it to process) pays for the scratch writes, the re-reads, *and* the buffer.
  When the consumer can run as the producer emits each value, fuse them into one
  pass writing straight to the final destination. This is often the biggest
  *structural* win — and no line-level tweak to either phase can find it, because
  the intermediate itself is the cost.

## 6. Memory layout and cache locality

Typed arrays buy more than "no boxing" — they buy *layout control*, and layout
decides whether the hot loop runs from cache or from memory.

- **Struct-of-arrays over array-of-structs.** A set of parallel typed arrays
  (`xs[i]`, `ys[i]`, `ids[i]`) beats an array of `{x, y, id}` objects: no
  per-object header, no pointer hop per access, and a loop touching only one
  field streams through exactly that field's bytes. Reach for AoS only when
  every access genuinely needs the whole record.
- **But a V8 object can beat *both* when the access pattern is whole-record.**
  When the hot loop reads many fields of one node at a time (a linked structure
  you pointer-chase through, touching `.next`, `.x`, `.y`, `.z` together), a
  plain object with a stable hidden class is hard to beat: each field is a
  fixed-offset load with no bounds check, and the whole record sits in ~one cache
  line. Re-encoding that as SoA scatters one logical node across several arrays
  (several cache lines per node-visit) and adds index arithmetic plus bounds
  checks; AoS-in-a-typed-array forces int/float reconversion on every link
  read. Both lost badly in practice (SoA +18%, AoS +112%) against the object
  version. The lesson isn't "objects win" — it's that **SoA wins for
  single-field streaming and loses for whole-record pointer-chasing**; match the
  layout to which one the hot loop actually does, and measure rather than assume
  typed arrays are always faster.
- **Traversal order is a real cost.** Sequential access over a contiguous
  array is what the prefetcher is built for; pointer-chasing through scattered
  objects (or random-index hopping through a huge array) is a cache miss per
  step. Prefer loops that walk memory in order, even at the cost of a little
  extra arithmetic.
- **When the hot loop is cache-miss-bound, stop tuning its arithmetic.** If the
  loop's real cost is the pointer-chase (each step waits on memory), cutting
  comparisons or strength-reducing the math inside it buys ~nothing — the CPU is
  stalled on the load, not the ALU. Confirm with a line-level profile (the cost
  sits on the dereference, not the compute). The wins then come from *outside*
  the body: the call boundary (#4 — hoist the common reject inline, inline the
  helper) and the data layout (locality, above). Several arithmetic micro-opts
  inside one such loop all landed ≤±1%, while two call-boundary changes on the
  same loop landed −6.5% and −3%.
- **Reordering the *data* can beat any change to the *code*.** Sorting records
  so that items accessed together sit together (e.g. spatial sort by
  Hilbert/Z-order curve before building a packed index) turns random access
  into local access for every later query. This is invisible to a line-level
  profile — the cost shows up smeared as "memory-bound everything" — so it has
  to come from reasoning about access patterns, not from a tall bar.
- Pack related small fields into one element (bitfields in a `Uint32Array`)
  when they're always read together: one load instead of several arrays' worth.

## 7. Bulk operations instead of element-by-element

- When source and destination layouts match, a single bulk copy
  (`dst.set(src.subarray(a, b))`, `Array.prototype.copyWithin`) beats a
  per-element loop and lets the engine use an optimized path.
- Provide a **fast path**: detect the common case where a cheap bulk operation
  applies, and fall back to the element loop only when it doesn't.
- Built-in range ops (`typedArray.fill(v, start, end)`) beat hand-written loops.

## 8. Hoist invariants and decisions out of the loop

- Lift the type/branch/config decision *above* the loop and emit a specialized
  loop body, instead of re-deciding every iteration.
- Hoist repeated property-chain reads into locals before the loop
  (`const items = this.state.items`). Repeated `this.a.b.c` in a hot loop is
  repeated lookups.

## 9. Specialize the common shapes

- Branch once on the dominant case (a fixed small size, the common type, the
  default config) and write a fully unrolled, simplified version for it. Removes
  inner-loop bookkeeping and dispatch.
- Keep a general fallback for the rare shapes — specialize the 90% case, don't
  rewrite the whole matrix.

## 10. Cheap substitutions — only in proven hot paths

- Micro-level rewrites (bit ops over arithmetic, `(x / n) | 0` over
  `Math.floor` for non-negative values below 2³¹, indexing a precomputed array
  over recomputing) are real but small. Reach for them only inside a loop the
  profiler actually flagged; elsewhere they just cost readability.
- Watch for subtle semantic shifts when rewriting numeric or boundary logic
  (overflow, rounding, sign, off-by-one). `| 0` truncates toward zero where
  `Math.floor` rounds toward −∞, and wraps above 2³¹ — a faster line that
  changes results is not an optimization, which is what the safety net in #0 is
  for.
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

## 11. Measuring against noise

- Run-to-run variance can be larger than the win you're chasing. A single
  before/after pair is not evidence.
- **A hot spot that's a small fraction of total can't be measured on the
  full-workload bench — isolate it.** Below roughly the bench's noise floor
  (single-digit % of total, even with interleaving), a real win on one function
  is invisible in end-to-end numbers because the noise on everything else swamps
  it. Pull that function into its own microbench driven by representative inputs
  and measure it directly; then sanity-check that the end-to-end number at least
  didn't regress. (Seen: a ~2.5% sort improvement that was unmeasurable on the
  full bench and only resolved in isolation.)
- **Let the JIT warm up before you trust a number.** Cold code runs in the
  interpreter/baseline tier, not the optimized tier that ships hot — benchmarking
  it measures code that never actually runs in production. Discard warmup
  iterations, or run long enough that the function tiers up before you record.
  (This interacts with #4: a call site that's polymorphic only during warmup can
  mislead in both directions.)
- **Make sure the benchmark's work can't be eliminated.** The JIT discards
  computation whose result is provably unused — a loop that calls the function
  under test and ignores the return value can measure nothing at all. Accumulate
  results into a checksum (or otherwise consume them after the loop) so every
  iteration's work stays observable.
- **Don't let the timer outweigh what it times.** At ns/op scale a per-iteration
  `performance.now()` (or counter bump) is itself a measurable cost *and* a
  distortion of the profile — it can show up as one of the tallest bars. Time
  coarse-grained instead: wrap the whole loop, or only the iterations that can
  actually vary, rather than every iteration. A sampling profiler avoids this
  probe cost entirely — prefer it over manual instrumentation for hot inner
  loops. (Seen: two `now()` calls per op were ~10% of the profile until moved off
  the per-iteration path.)
- **Interleave A and B runs (ABAB), not batched (AAAA-BBBB).** Thermal
  throttling, clock drift, and accumulating background load bias whichever
  variant runs later; alternating cancels the drift instead of attributing it to
  one side.
- **Control the machine, not just the code.** Background load, thermal
  throttling, efficiency vs performance cores (Apple Silicon may schedule a
  long-running quiet process onto E-cores), and Node version drift each move
  numbers more than a small win. Compare only runs from the same Node binary on
  the same machine state; treat any cross-machine or cross-version comparison as
  a different experiment.
- Use a stable summary across repeated runs (e.g. best-of-best over N runs) when
  the metric is noisy; keep N high enough that the clusters separate.
- To isolate one change's effect, revert *only* the code under test — not the
  scaffolding (build config, harness, fixtures) the measurement needs to run.
- **"Does less work" is a hypothesis, not a result — and it's data-dependent.** A
  change that provably executes fewer operations can still be slower: e.g.
  replacing one blanket bulk operation with several targeted ones loses when the
  data favors the single contiguous path, because many small ops cost more than
  one big one. Validate every "obviously cheaper" change on a *representative*
  workload, and re-measure before carrying it to data with a different
  distribution.

## 12. Report what you measured, not what you concluded

- Show **raw numbers and the exact commands** that produced them — never a
  rounded "~15% faster" without the data behind it. The reader must be able to
  reproduce the measurement, and the raw numbers often reveal what a summary
  hides (bimodal runs, one outlier case carrying the average).
- Report **per-case** numbers, not just one blended aggregate — individual large
  speedups are legible where a single median hides them and drowns in noise.
- **Never report a win that wasn't measured.** A change that should be faster
  by reasoning is a hypothesis (see #11) — label it as such, or measure it. The
  same goes for changes kept "because they can't hurt": unmeasured is unproven.
- State what was *not* tested: workloads, data distributions, or engines the
  numbers don't cover. A win on one distribution carried silently to another is
  how regressions ship with a green report attached.

## 13. Don't trade correctness for speed silently

- Removing work because "the only current caller doesn't need it" is a latent
  bug. Guard it behind a cheap flag computed once instead, so it stays correct
  for any future caller at the same speed.

---

## The meta-lesson

The biggest gap between a modest result and a large one is usually **not**
knowledge of any single technique above. It's four habits:

1. **Make change safe first.** A weak verification net caps both your vision
   (you can't see what's already wrong) and your nerve (you won't attempt the
   rewrites that win big).
2. **Snipe, then sweep — and know which you're doing.** Clear the cheap blunders
   at the tallest bars first; that's where one-line, outsized wins hide. But once
   the peaks are real, irreducible costs, the leverage flips to a high-leverage
   mechanical technique (flatten dispatch, kill allocation, specialize the common
   case) applied across the whole distribution. Staying in the wrong mode for the
   regime you're in is the trap.
3. **Profile the *real* workload before you trust your cost model — and welcome a
   second set of eyes.** A careful up-front analysis can confidently rank the
   wrong hot path; only profiling the actual workload reveals where time really
   goes. And the largest structural wins often come from a fresh perspective that
   spots a redundant pass incremental profiling had normalized into the
   background. Your own profile, read alone, anchors you to the costs you already
   expected to find.
4. **Spike the premise before you commit to the plan.** A big optimization plan
   rests on a belief about *why* the code is slow — and that belief can be wrong.
   Before building the whole structural change, prototype its core assumption
   cheaply (a throwaway spike, or just a counter — meta-lesson 3 above and #2)
   and let it earn the work. The headline plan that opens a session is the most
   dangerous thing in it: it's the hypothesis you're least likely to re-examine
   once you've started building. (Seen: a session-opening plan to replace a
   spatial sort everywhere, redirected entirely by a weekend of spikes showing
   the sort was irreplaceable on the hot path and the real win lived elsewhere.)

The techniques are common knowledge. The discipline of applying them broadly,
under the protection of a check you trust, is what produces the large win.
