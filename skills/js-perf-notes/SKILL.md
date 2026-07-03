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

This is a **reference to consult**, not a procedure to run start-to-finish —
only "The loop" below is sequential. Techniques live in on-demand files under
`techniques/`; see the catalog below.

## The loop

Every optimization session is the same cycle:

1. **Profile** the real workload (see #4 for tooling).
2. **Hypothesize** from the profile — not from reading the code (#3).
3. **Change one thing** — routing to the matching `techniques/` file via the
   catalog below once the bottleneck type is clear.
4. **Verify correctness** against the safety net (#1).
5. **Measure** against noise (#5), then keep or revert — never skip this and
   claim the win anyway; "should be faster" is a hypothesis, not a result.
6. **Re-profile before the next change.** The distribution shifts after every
   kept win; a stale profile sends you chasing bars that no longer exist.

## 1. Make change safe before you make it fast

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

## 2. Tallest bars first, then the aggregate

Attack the highest *self-time* functions first — then switch to sweeping the
whole distribution once the obvious peaks are gone.

- **First pass: the peaks.** A tall bar is often a *blunder* — accidental O(n²),
  redundant work, pathological allocation, or a call that shouldn't be hot. Clear
  these cheap, outsized wins first.
- **Then sweep the flattened distribution.** Once the peaks are genuine costs,
  leverage moves to mechanical techniques applied broadly: flatten dispatch, kill
  allocation, specialize common shapes. Don't keep sniping once the profile says
  the costs are spread out.
- **Question the algorithm before sweeping mechanically.** Is the data structure
  right for the workload's actual access pattern? Is there a known algorithm
  with better complexity or constants for this problem shape? Loop-level polish
  can't recover what a wrong algorithm gives away. And when no JS-level change
  suffices, ask whether the work belongs in this layer at all: precompute
  offline, cache at a higher level, or drop the kernel to WASM/SIMD.

## 3. Read the profile, not your cost model

The profile is the authority; your static reading of the code is a hypothesis.

- **Don't trust an a-priori cost ranking — profile the real workload first.**
  Static reading enumerates candidates; the profile ranks them.
- **Self-time is reported *after* inlining.** The engine folds small helpers into
  their callers, so a tall self-time bar may actually be inlined callees doing the
  work — and a helper that looks cheap may be hot everywhere it gets inlined. Before
  acting on a bar, drop to line-level / position ticks to confirm what's actually
  executing there. (Seen: 17% self-time in a function whose cost was an inlined
  sort; the sort's own frame read 2.7%.)
- **Group by a domain-meaningful dimension *and* read per-line — they answer
  different questions.** Per-group (by input type/config/size) tells you which
  *workload* dominates; per-line tells you which *code* executes most. They
  disagree when a hot line cross-cuts groups: the per-group view blames one
  category while a single line running across *all* of them is the real peak.
  Reconcile both before acting.
- **Counter-first on algorithmic ideas — instrument the domain counts before
  prototyping.** A profile tells you where *time* goes; before building a
  structural change, quantify the *premise* it rests on with a cheap counter:
  the prune rate the new index would buy, the fraction of iterations wasted, the
  composition of the candidate set you mean to filter. A false premise dies for
  free this way — no code written. The profile ranks the code you have; counters
  test the code you're about to write.

## 4. Capturing evidence: the profiling toolkit

Get the profile headlessly, then confirm hypotheses with trace flags.

- **Sampling profile — *where* time goes.** `flamebearer` summarizes Chrome
  traces (`.json`/`.gz`) and Node `.cpuprofile`s into a text report;
  `flamebearer-node bench.js` profiles a script in one step (`--help` for flags).
  Always run `which flamebearer-node` first: if installed (or repo-local),
  use it — no approval needed, and its `--stacks <fn>` flag gives **per-line
  self-time including inlined code**, the line-level confirmation #3 demands
  before acting on a tall bar. Only if absent (and you'd rather not ask to
  `npm i -g flamebearer`), fall back to `node --cpu-prof bench.js`, which
  writes a `*.cpuprofile` (plain JSON — parse it directly); the discipline
  (#2, #3) matters more than the tool.
- **Trace flags — *why* the engine couldn't make it fast.** `node --trace-deopt
  … | grep <fn>` shows a hot function kicked back to baseline and names the
  unstable type/field; `--log-ic` surfaces inline-cache state transitions
  (evidence for `techniques/dispatch-inlining.md`);
  `--allow-natives-syntax` + `%GetOptimizationStatus(fn)` after warmup confirms
  it actually reached the optimizing tier.
- The two are complementary — get trace evidence before an engine-level rewrite
  about deopts, inlineability, dispatch, or type instability.

---

## Technique catalog — load by bottleneck type

Once the profile tells you what kind of bottleneck you have, read the matching
file below. Start with the one the profile points at; load another only when
evidence or a cross-reference points there.

- **Call/dispatch overhead** → `techniques/dispatch-inlining.md`. Symptoms: a hot
  loop calling helpers; polymorphic/megamorphic call sites (`--log-ic` shows
  unstable inline-cache state); a function too big to inline its callees; deopts
  from type instability. Often the highest-leverage mechanical technique — load
  this first when the hot bar is doing dispatch rather than compute.
- **Memory: allocation, layout, locality, bulk ops** → `techniques/memory.md`.
  Symptoms: GC is a real slice of the profile; the loop is cache-miss-bound (cost
  on a dereference, not the math); per-iteration allocation; or you're choosing a
  representation (typed arrays vs objects, SoA vs AoS, packing fields).
- **Loop-body compute** → `techniques/loops.md`. Symptoms: a profiler-flagged hot
  loop doing redundant per-iteration work, re-deciding a branch/config every
  iteration, transcendental/library math per element, or data-dependent branches.

These files cite **V8** specifics (SMI ranges, inlining budgets, shape
monomorphism); other engines share the principles but differ in detail, so
re-verify browser wins rather than asserting V8 behavior as universal.

## 5. Measuring against noise

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
  (This interacts with dispatch — see `techniques/dispatch-inlining.md`: a call
  site that's polymorphic only during warmup can mislead in both directions.)
- **Make sure the benchmark's work can't be eliminated.** The JIT discards
  computation whose result is provably unused — a loop that calls the function
  under test and ignores the return value can measure nothing at all. Accumulate
  results into a checksum (or otherwise consume them after the loop) so every
  iteration's work stays observable.
- **Don't let the timer outweigh what it times.** At ns/op scale a per-iteration
  `performance.now()` (or counter bump) is itself a cost *and* a distortion of
  the profile (seen: two `now()` calls per op were ~10% of it). Time
  coarse-grained — wrap the whole loop — and prefer a sampling profiler over
  manual instrumentation for hot inner loops.
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
- **"Does less work" is a hypothesis, and data-dependent.** Provably fewer
  operations can still be slower (e.g. several targeted small ops losing to one
  blanket bulk op when the data favors the contiguous path). Validate every
  "obviously cheaper" change on a *representative* workload; re-measure before
  carrying it to a different distribution.

## 6. Before reporting: the gate

Every claim in the report must pass all four:

- **Measured, not reasoned.** No unmeasured "should be faster" or kept-because-
  it-can't-hurt wins — label hypotheses as hypotheses (see #5).
- **Raw numbers + exact commands**, so the reader can reproduce them and spot
  what a summary hides (bimodal runs, one outlier carrying the average).
- **Per-case numbers**, not one blended aggregate that drowns individual wins.
- **Untested workloads/distributions/engines stated.** A win carried silently
  to a different distribution is how regressions ship with a green report.

## 7. Don't trade correctness for speed silently

- Removing work because "the only current caller doesn't need it" is a latent
  bug. Guard it behind a cheap flag computed once instead, so it stays correct
  for any future caller at the same speed.

## Two final habits, easy to forget

- **Welcome a second set of eyes.** Fresh perspective can spot a redundant pass
  that incremental profiling normalized into the background; your own profile,
  read alone, anchors you to expected costs.
- **Distrust the opening plan.** It's the hypothesis you're least likely to
  re-examine once you start building. Spike its premise first. (Seen: a plan to
  replace a spatial sort everywhere, redirected after spikes showed the sort was
  irreplaceable and the real win lived elsewhere.)

The techniques are common knowledge. The discipline — a trusted safety net, real
profiles, cheap premise spikes, and honest measurements — is what produces the
large win.
