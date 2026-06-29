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
only "The loop" below is sequential; everything else is keyed by topic. The
bottleneck-specific *techniques* live in on-demand files under `techniques/`
(see the catalog index below). Principles are calibrated against V8; re-verify
on other engines.

## The loop

Every optimization session is the same cycle:

1. **Profile** the real workload (see #4 for tooling).
2. **Hypothesize** from the profile — not from reading the code (#3).
3. **Change one thing.**
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

## 3. Read the profile, not your cost model

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

## 4. Capturing evidence: the profiling toolkit

Get the profile headlessly, then confirm hypotheses with trace flags.

- **Sampling profile — *where* time goes.** `flamebearer` summarizes Chrome
  traces (`.json`/`.gz`) and Node `.cpuprofile`s into a text report;
  `flamebearer-node bench.js` profiles a script in one step (`--help` for flags).
  Check for an existing or repo-local copy first; install
  (`npm i -g flamebearer`) only with user approval. The flag that matters for the
  method: `--stacks <fn>` gives **per-line self-time including inlined code** —
  the line-level confirmation #3 demands before acting on a tall bar. Nothing
  hinges on this tool, though: the `.cpuprofile` is a standard format any
  sampling-profiler reader can parse, and the discipline (#2, #3) matters more
  than the tool.
- **Trace flags — *why* the engine couldn't make it fast.** `node --trace-deopt
  … | grep <fn>` shows a hot function kicked back to baseline and names the
  unstable type/field; `--trace-ic` surfaces megamorphic sites (`N`-marked
  transitions — evidence for `techniques/dispatch-inlining.md`);
  `--allow-natives-syntax` + `%GetOptimizationStatus(fn)` after warmup confirms
  it actually reached the optimizing tier.
- The two are complementary — get both before a non-obvious rewrite.

---

## Technique catalog — load by bottleneck type

The numbered sections of this file (#1–#7) are **always-on methodology**: they
apply to every session, so they live here. The specific *techniques* are split
into on-demand files — once the profile tells you what kind of bottleneck you
have, read the matching file. Don't load all three preemptively; load the one
the profile points at.

- **Call/dispatch overhead** → `techniques/dispatch-inlining.md`. Symptoms: a hot
  loop calling helpers; polymorphic/megamorphic call sites (`--trace-ic` shows
  `N`-marked transitions); a function too big to inline its callees; deopts from
  type instability. Often the highest-leverage mechanical technique — load this
  first when the hot bar is doing dispatch rather than compute.
- **Memory: allocation, layout, locality, bulk ops** → `techniques/memory.md`.
  Symptoms: GC is a real slice of the profile; the loop is cache-miss-bound (cost
  on a dereference, not the math); per-iteration allocation; or you're choosing a
  representation (typed arrays vs objects, SoA vs AoS, packing fields).
- **Loop-body compute** → `techniques/loops.md`. Symptoms: a profiler-flagged hot
  loop doing redundant per-iteration work, re-deciding a branch/config every
  iteration, transcendental/library math per element, or data-dependent branches.

These technique files cite **V8** engine-level specifics — SMI ranges, inlining
budgets, shape monomorphism. Other engines (JSC, SpiderMonkey) share the broad
principles but differ in details; if the code targets browsers, re-verify wins
there rather than asserting V8 behavior as universal JS truth.

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

## 6. Report what you measured, not what you concluded

- Show **raw numbers and the exact commands** that produced them — never a
  rounded "~15% faster" without the data behind it. The reader must be able to
  reproduce the measurement, and the raw numbers often reveal what a summary
  hides (bimodal runs, one outlier case carrying the average).
- Report **per-case** numbers, not just one blended aggregate — individual large
  speedups are legible where a single median hides them and drowns in noise.
- **Never report a win that wasn't measured.** A change that should be faster
  by reasoning is a hypothesis (see #5) — label it as such, or measure it. The
  same goes for changes kept "because they can't hurt": unmeasured is unproven.
- State what was *not* tested: workloads, data distributions, or engines the
  numbers don't cover. A win on one distribution carried silently to another is
  how regressions ship with a green report attached.

## 7. Don't trade correctness for speed silently

- Removing work because "the only current caller doesn't need it" is a latent
  bug. Guard it behind a cheap flag computed once instead, so it stays correct
  for any future caller at the same speed.

---

## The meta-lesson

The gap between a modest result and a large one is rarely knowledge of any
technique above — it's the discipline of applying them. Four habits carry most
of it; the first two just restate the sections, the last two add what they don't:

1. **Make change safe first (#1)** — a weak net caps both vision and nerve.
2. **Know whether you're sniping or sweeping (#2)** — the wrong mode for the
   regime you're in is the trap.
3. **Profile the real workload (#3) — and welcome a second set of eyes.** The
   largest structural wins often come from a fresh perspective spotting a
   redundant pass that incremental profiling had normalized into the background.
   Your own profile, read alone, anchors you to the costs you already expected.
4. **Spike the premise before committing to the plan.** The headline plan that
   opens a session is the most dangerous thing in it — the hypothesis you're
   least likely to re-examine once you've started building. Prototype its core
   assumption cheaply (a spike, or just a counter — #3) first. (Seen: a
   session-opening plan to replace a spatial sort everywhere, redirected by a
   weekend of spikes showing the sort was irreplaceable and the real win lived
   elsewhere.)

The techniques are common knowledge. The discipline of applying them broadly,
under the protection of a check you trust, is what produces the large win.
