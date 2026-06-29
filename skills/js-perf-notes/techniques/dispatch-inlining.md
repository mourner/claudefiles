# Dispatch and inlining

Techniques for when the bottleneck is **call overhead** in a hot loop — often
the highest-leverage *mechanical* category.

## Kill polymorphic / megamorphic dispatch in hot loops

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
- **Inlining is a property of a specific caller→callee *edge*, not of a
  function — re-verify the exact edge your optimization rests on, not a
  neighbouring one.** Shrinking a function changes some of its inline edges but
  not others; confirming that one edge now inlines doesn't license "the budget
  got bigger" everywhere. In particular, whether `f` inlines *into* its caller
  and whether `f`'s own callees inline *into* `f` are independent questions — a
  change that flips one can leave the other exactly as it was. When a past win
  depended on some edge *not* inlining (e.g. a cheap reject hoisted into the
  caller precisely because the expensive helper stays a real call), recheck
  *that* edge with `--trace-turbo-inlining` before assuming a refactor has made
  it safe to undo.
- Hoist the concrete leaf object out of a dispatch chain: if `a.doX()` just
  forwards to `this.impl.x()`, grab `impl` once and call it directly in the loop.
- Keep objects monomorphic — initialize all fields in the constructor in the same
  order, so the engine sees one consistent shape.
- **Watch for deopts, not just un-optimized code.** A hot function can be
  optimized and then kicked back to baseline mid-run by *type* instability — a
  field or loop variable that switches between int and double, a number that
  overflows into a float, reading `arguments`. Keep the types a hot path sees
  stable, not just the object shapes.
