# Memory: allocation, layout, locality, bulk ops

Techniques for when the bottleneck is **memory-shaped** — allocation/GC, cache
locality, or choice of data representation. Measure GC% *before* chasing
allocation: it's a reflex often aimed at a non-problem.

## Use typed arrays; avoid per-iteration allocation

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

## Memory layout and cache locality

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
  the body: the call boundary (hoist the common reject inline, inline the helper —
  see techniques/dispatch-inlining.md) and the data layout (locality, above).
  Several arithmetic micro-opts inside one such loop all landed ≤±1%, while two
  call-boundary changes on the same loop landed −6.5% and −3%.
- **Reordering the *data* can beat any change to the *code*.** Sorting records
  so that items accessed together sit together (e.g. spatial sort by
  Hilbert/Z-order curve before building a packed index) turns random access
  into local access for every later query. This is invisible to a line-level
  profile — the cost shows up smeared as "memory-bound everything" — so it has
  to come from reasoning about access patterns, not from a tall bar.
- Pack related small fields into one element (bitfields in a `Uint32Array`)
  when they're always read together: one load instead of several arrays' worth.

## Bulk operations instead of element-by-element

- When source and destination layouts match, a single bulk copy
  (`dst.set(src.subarray(a, b))`, `Array.prototype.copyWithin`) beats a
  per-element loop and lets the engine use an optimized path.
- Provide a **fast path**: detect the common case where a cheap bulk operation
  applies, and fall back to the element loop only when it doesn't.
- Built-in range ops (`typedArray.fill(v, start, end)`) beat hand-written loops.
