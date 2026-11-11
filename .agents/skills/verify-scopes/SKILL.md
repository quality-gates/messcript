---
name: verify-scopes
description: "Formally verify lexical scoping, hoisting, and write mutation classification in messcript/src/ast/scopes.ts using TLA+ and statechart. Use whenever modifying ScopeBuilder, declaration hoisting, reference resolution, or write classification."
---

# Verify Scopes State Machine

This skill formally verifies the lexical scoping and binding mutation state machine in [`src/ast/scopes.ts`](file:///Users/jonathanbaldie/Code/pstack/quality-gates/messcript/src/ast/scopes.ts#L301-L407) using a TLA+ model checked by TLC via the pstack `/statechart` skill.

## Covered code

- **Files:** [`src/ast/scopes.ts`](file:///Users/jonathanbaldie/Code/pstack/quality-gates/messcript/src/ast/scopes.ts)
- **Functions:** `ScopeBuilder.build()`, `ScopeBuilder.declareNames()`, `ScopeBuilder.recordWrites()`, `analyzeScopes()`
- **Sync commit:** `ee472067793f11a44fec4f7699cd46cedc039c64`

## Properties verified

1. **`VarNeverInBlockScope`**: `var` declarations hoist to the nearest function or file scope and never bind into block scopes.
2. **`LoopIncrementorExclusion`**: Write updates occurring inside loop incrementor clauses (`for (...; ...; i++)`) do not mark the binding as mutated for closure escape analysis.
3. **`NoDeadlock`**: Scope building and reference resolution terminate cleanly.

## How to run

Run the verification using `/statechart`:

```sh
.agents/skills/statechart/scripts/statechart quality-gates/messcript/formal/scopes/Scopes.tla --config quality-gates/messcript/formal/scopes/Scopes.cfg --out quality-gates/messcript/formal/scopes/out
```

Read every result with the pstack `/statechart` skill. If TLC finds an invariant violation, `/statechart` reports the shortest counterexample path in plain words. When the check passes, it generates a Mermaid statechart in `quality-gates/messcript/formal/scopes/out/chart.mmd`.

## Bounds and assumptions

- Scope: Hierarchy bounded to 3 scope levels (`file`, `function`, `block`) with a 3-step transition budget.
- Assumption: Identifiers and syntax kinds correspond to TypeScript compiler AST tokens.
