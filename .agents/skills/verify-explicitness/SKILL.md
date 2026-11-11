---
name: verify-explicitness
description: "Formally verify the inter-procedural fixed-point dataflow iteration state machine in messcript/src/analysis/explicitness.ts using TLA+ and statechart. Use whenever modifying callable summarization, fixed-point round loops, convergence checks, or side-effect fallback."
---

# Verify Explicitness State Machine

This skill formally verifies the inter-procedural fixed-point dataflow iteration state machine in [`src/analysis/explicitness.ts`](file:///Users/jonathanbaldie/Code/pstack/quality-gates/messcript/src/analysis/explicitness.ts#L2930-L2975) using a TLA+ model checked by TLC via the pstack `/statechart` skill.

## Covered code

- **Files:** [`src/analysis/explicitness.ts`](file:///Users/jonathanbaldie/Code/pstack/quality-gates/messcript/src/analysis/explicitness.ts)
- **Functions:** `analyzeImplicitFlows()`, `summarizeCallable()`, `shareExposedReturns()`
- **Sync commit:** `ee472067793f11a44fec4f7699cd46cedc039c64`

## Properties verified

1. **`FallbackNeverClaimsPurity`**: When the fixed-point iteration hits its bound (`round = callables.length + 8`) without stabilizing, it transitions into `UnconvergedFallback` and emits `unknown` effect findings, never claiming zero side effects.
2. **`ConvergedStatusConsistent`**: The engine marks analysis as converged if and only if summary keys and shared binding counts match the preceding round.
3. **`NoDeadlock`**: The analyzer progresses through rounds and terminates either in `Converged` or `UnconvergedFallback`.

## How to run

Run the verification using `/statechart`:

```sh
.agents/skills/statechart/scripts/statechart quality-gates/messcript/formal/explicitness/Explicitness.tla --config quality-gates/messcript/formal/explicitness/Explicitness.cfg --out quality-gates/messcript/formal/explicitness/out
```

Read every result with the pstack `/statechart` skill. If TLC finds an invariant violation, `/statechart` reports the shortest counterexample path in plain words. When the check passes, it generates a Mermaid statechart in `quality-gates/messcript/formal/explicitness/out/chart.mmd`.

## Bounds and assumptions

- Scope: Bounded to 2 concurrent callables across 4 iteration rounds.
- Assumption: Abstract flow summaries are lattice-bounded integers (0..2).
