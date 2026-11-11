---
name: verify-rulesets
description: "Formally verify the XML pushdown automaton and recursive ruleset expansion state machine in messcript/src/rulesets.ts using TLA+ and statechart. Use whenever modifying XML tag parsing, attribute handling, or ruleset file inheritance."
---

# Verify Rulesets State Machine

This skill formally verifies the XML pushdown automaton and recursive ruleset expansion state machine in [`src/rulesets.ts`](file:///Users/jonathanbaldie/Code/pstack/quality-gates/messcript/src/rulesets.ts#L55-L190) using a TLA+ model checked by TLC via the pstack `/statechart` skill.

## Covered code

- **Files:** [`src/rulesets.ts`](file:///Users/jonathanbaldie/Code/pstack/quality-gates/messcript/src/rulesets.ts)
- **Functions:** `tagEnd()`, `parseTag()`, `parseXml()`, `expandCustomFile()`, `expandContainer()`
- **Sync commit:** `ee472067793f11a44fec4f7699cd46cedc039c64`

## Properties verified

1. **`DoneImpliesEmptyStack`**: When parsing terminates successfully with `status = "Done"`, the XML element stack is completely empty. Unclosed nested tags cannot be declared done.
2. **`CycleCaught`**: Any circular file reference encountered during recursive expansion (`state.stack`) forces the state machine into `CycleError` and halts recursion.
3. **`NoDeadlock`**: The parser progresses through tags and terminates either in a valid completion or a classified error (`ParseError`, `CycleError`, `Timeout`).

## How to run

Run the verification using `/statechart`:

```sh
.agents/skills/statechart/scripts/statechart quality-gates/messcript/formal/rulesets/Rulesets.tla --config quality-gates/messcript/formal/rulesets/Rulesets.cfg --out quality-gates/messcript/formal/rulesets/out
```

Read every result with the pstack `/statechart` skill. If TLC finds an invariant violation, `/statechart` reports the shortest counterexample path in plain words. When the check passes, it generates a Mermaid statechart in `quality-gates/messcript/formal/rulesets/out/chart.mmd`.

## Bounds and assumptions

- Scope: Depth bounded to 3 nested XML elements; step budget bounded to 4 transitions.
- Assumption: Tag and attribute strings are pre-tokenized by `parseTag()`.
