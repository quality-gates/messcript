# Exploratory testing — explicitness ruleset — 2026-09-23

## Scope

The diff of `feat/explicitness-ruleset` against `origin/main`: the new
`explicitness` ruleset (`ImplicitInput`, `ImplicitOutput`, and the `include-this`
property) and its docs. It was built from `5d0c881` plus the uncommitted feature
changes (`npm run build`), messcript 0.1.10, Node v26.7.0, macOS. The fixtures
were isolated under `/tmp/mx-expl`. The unrelated worktree changes (`.serena/`,
`AGENTS.md`, `.agents/`, `perffuzz/`) are out of scope and were not touched.

## Baseline

- `npm test`: 275 tests pass, exit 0.
- Self-check `node dist/cli.js src text typescript --ignore-tests`: exit 0.

## Journeys

### 1. Find the implicit inputs and outputs in a real codebase (explored)

Goal: run `explicitness` on a project and get findings that match the definition.

`node dist/cli.js src text explicitness --ignore-tests` gave 108 findings and
exit 2. Spot checks were all correct by the definition: closure reads of a
mutated outer `let`, `process.cwd()`, `stack[...] +=`, `state.warnings.push`, and
`result ??=`.

Variation: a generated file with 20 000 functions (60 000 findings). With
`explicitness` the run took 2.21 s. With `design` on the same file it took 1.87 s.

### 2. Configure the ruleset (explored)

Goal: enable, combine, tune, and silence the rules as documented.

All of these behaved as documented:

- the short name `explicitness`
- the group reference `rulesets/explicitness.xml` with properties
- `include-this` set per rule (input only), and case-insensitive `TRUE`
- combining with `typescript`
- `--only ImplicitOutput`
- `--disable` (exit 0 when all rules are disabled)
- `messcript-disable-next-line ImplicitOutput`
- SARIF output

An unknown ruleset failed with exit 1. The recommended `typescript` policy does
not include the rules.

### 3. Trust the findings on ordinary constructs (explored)

Goal: each construct gives the flow that `docs/rules.md` describes.

These were all correct:

- host reads (`process.env`) and host writes (`process.stdout.write`)
- mutated imports (reported) and unmutated imports (quiet)
- namespace `x++` (both an input and an output)
- callbacks that mutate an outer array
- local shadows of host names (quiet)
- `new Date` without parentheses
- `fetch` inside `async` functions
- destructured tuples

A TSX file with JSX handlers, generators, static blocks, overloads, abstract
members, `declare`, labels, and an anonymous default export gave correct
findings. It did not crash.

This journey found confirmed bug 1. It also left one unresolved candidate (U1)
and one observation (O2).

## Confirmed bugs

### 1. Sinks reached through the global object are reported as reads, not outputs

- **Impact:** `window.alert()`, `globalThis.setTimeout()`, `self.fetch()`, and
  `window.console.log()` did not produce `ImplicitOutput`. The docs name these
  sinks, so a function that sends data out passed an `ImplicitOutput` gate.
- **Starting conditions:** the `explicitness` ruleset and the default properties.
- **Replay:** put `function f() { window.alert(); }` in `m.js`. Run
  `node dist/cli.js m.js text explicitness`.
- **Expected:** `ImplicitOutput … uses alert`.
- **Actual:** only `ImplicitInput … reads window`.
- **Repeats:** 3 of 3 runs gave the same result. The controls isolated the
  `window.` prefix as the cause.
- **Evidence:** [evidence/2026-09-23-global-object-sinks.md](evidence/2026-09-23-global-object-sinks.md)
- **Status:** fixed on this branch.
  - Cause: `ambientFlow` checked only the root identifier against the sinks.
  - Fix: resolve `window`/`globalThis`/`self` member names first.
  - Regression test: in `test/explicitness.test.mjs`.
  - Checks: `npm test` 276 of 276 pass, and the self-check exits 0.

## Unresolved candidates

- **U1: effect calls on host objects are inputs.** `window.location.assign(url)`
  and `process.exit(1)` give only `ImplicitInput reads window` / `reads process`.
  These calls are effects. But the docs define host outputs as "writes to host
  objects", and the rule has no method list for host effects. The expected
  classification is not grounded, so this is not confirmed. A product decision
  is needed: add a host-effect method list, or document that these calls are
  reads.

## Doc corrections made

- `docs/rules.md` said "Imports … are not reported". Mutated imports are
  reported, which is correct behaviour. The text now says that imports and `const`
  bindings are reported only when the file mutates them.
- The `ImplicitOutput` row now says that sinks count when reached through
  `window`, `globalThis`, or `self`.

## Usability observations

- **O1: noise from nested callbacks.** Most of the 108 self-scan findings come
  from `visit` closures that push to an outer `findings` array. Each is correct
  by the definition. On a visitor-style codebase this makes the ruleset loud.
  - Suggestion (not done): document the pattern, or add a per-rule option to
    skip closures that write to variables of their enclosing function.
- **O2: loop closures over `let`.** In
  `for (let i = 0; …; i++) { hs.push(() => i); }`, the arrow gives `reads i`.
  JavaScript creates a new `i` for each iteration, so the closure's `i` does not
  change after capture. The docs rule ("mutated somewhere in the file") is met,
  so this matches the docs. It is still a probable false positive for readers.

## Limitations and unexplored areas

- By design, messcript does not follow calls. For example, `fs.writeFileSync`
  through an import is not reported.
- `history` and other host objects that are not in the list are not reported.
- Report formats other than `text`, `json`, and `sarif` were not re-checked for
  this ruleset. They use the shared reporter.
- `--strict` with suppressed explicitness findings was not exercised.
- A tagged debug probe (`[DEBUG-b7e1]`) was added to `src/analysis/explicitness.ts`
  for the diagnosis, then removed. `grep` finds no tags.

## Issues filed

Confirmed bug 1 is not filed. It was in unmerged branch code and is fixed on that
branch.

- U1: [#210](https://github.com/quality-gates/messcript/issues/210)
- O2: [#211](https://github.com/quality-gates/messcript/issues/211)
