---
name: verify-suppressions
description: "Formally verify the line-by-line comment suppression state machine in messcript/src/suppressions.ts using TLA+ and statechart. Use whenever modifying directive parsing, enable/disable precedence, or line suppression propagation."
---

# Verify Suppressions State Machine

This skill formally verifies the line-by-line comment suppression state machine in [`src/suppressions.ts`](file:///Users/jonathanbaldie/Code/pstack/quality-gates/messcript/src/suppressions.ts#L51-L100) using a TLA+ model checked by TLC via the pstack `/statechart` skill.

## Covered code

- **Files:** [`src/suppressions.ts`](file:///Users/jonathanbaldie/Code/pstack/quality-gates/messcript/src/suppressions.ts)
- **Functions:** `suppressedRulesByLine()`, `directivesIn()`, `applySuppressions()`
- **Sync commit:** `ee472067793f11a44fec4f7699cd46cedc039c64`

## Properties verified

1. **`CountNonNegative`**: The reference count of active region suppressions never underflows below zero, even if an `enable` directive appears without a prior `disable`.
2. **`NoDeadlock`**: The scanner progresses sequentially line by line and terminates cleanly.
3. **`DirectivePrecedence`**: `enable` directives take effect before recording the current line snapshot; `disable` and `disable-next-line` take effect after recording, ensuring single-line directives apply strictly to $L+1$ without leaking to $L+2$.

## How to run

Run the verification using `/statechart`:

```sh
.agents/skills/statechart/scripts/statechart quality-gates/messcript/formal/suppressions/Suppressions.tla --config quality-gates/messcript/formal/suppressions/Suppressions.cfg --out quality-gates/messcript/formal/suppressions/out
```

Read every result with the pstack `/statechart` skill. If TLC finds an invariant violation, `/statechart` reports the shortest counterexample path in plain words. When the check passes, it generates a Mermaid statechart in `quality-gates/messcript/formal/suppressions/out/chart.mmd`.

## Bounds and assumptions

- Scope: Bounded to 4 lines with non-deterministic directive selection (`none`, `disable`, `enable`, `disable_next_line`).
- Assumption: Directives are pre-parsed into valid rule tokens.
