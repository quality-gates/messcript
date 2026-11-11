---
name: verify-rule-evaluators
description: "Formally verify object literal key collisions and ReDoS regex safety caching in messcript/src/rules/ using TLA+ and statechart. Use whenever modifying DuplicatedArrayKey accessor checks or IgnorePattern probe caching."
---

# Verify Rule Evaluators State Machine

This skill formally verifies the clean code rule state machines in [`src/rules/duplicated-array-key.ts`](file:///Users/jonathanbaldie/Code/pstack/quality-gates/messcript/src/rules/duplicated-array-key.ts#L106-L145) and [`src/rules/ignore-pattern.ts`](file:///Users/jonathanbaldie/Code/pstack/quality-gates/messcript/src/rules/ignore-pattern.ts#L174-L203) using a TLA+ model checked by TLC via the pstack `/statechart` skill.

## Covered code

- **Files:** [`src/rules/duplicated-array-key.ts`](file:///Users/jonathanbaldie/Code/pstack/quality-gates/messcript/src/rules/duplicated-array-key.ts), [`src/rules/ignore-pattern.ts`](file:///Users/jonathanbaldie/Code/pstack/quality-gates/messcript/src/rules/ignore-pattern.ts)
- **Functions:** `checkObjectLiteral()`, `compileIgnorePattern()`, `assertPatternIsCheap()`
- **Sync commit:** `ee472067793f11a44fec4f7699cd46cedc039c64`

## Properties verified

1. **`GetAndSetNotAConflict`**: An object literal defining both a getter and a setter on the same key transitions to `GetAndSet` without flagging a collision. Two getters, two setters, or mixed getter/value transitions to `Conflict`.
2. **`CacheIntegrity`**: Transient evaluation timeouts (caused by process jitter or system load) bypass the cache, preventing temporary slowdowns from permanently rejecting valid regex patterns.
3. **`NoDeadlock`**: Property key accumulation and regex compilation terminate cleanly.

## How to run

Run the verification using `/statechart`:

```sh
.agents/skills/statechart/scripts/statechart quality-gates/messcript/formal/rule-evaluators/RuleEvaluators.tla --config quality-gates/messcript/formal/rule-evaluators/RuleEvaluators.cfg --out quality-gates/messcript/formal/rule-evaluators/out
```

Read every result with the pstack `/statechart` skill. If TLC finds an invariant violation, `/statechart` reports the shortest counterexample path in plain words. When the check passes, it generates a Mermaid statechart in `quality-gates/messcript/formal/rule-evaluators/out/chart.mmd`.

## Bounds and assumptions

- Scope: Bounded to 3 property declarations per object literal.
- Assumption: Keys are statically determinable strings or literal numbers.
