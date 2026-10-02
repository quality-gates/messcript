# Exploratory testing — messcript — 2026-10-03

## Scope

Full CLI pass on messcript 0.1.15, built from `origin/main` at `c920402` (`npm test`, which runs `tsc --build`). Node v26.7.0, macOS. This build includes the fixes for #271–#275. Isolated fixtures lived under `/tmp/mx-et-1003` and were removed afterwards. Replays use [evidence/2026-10-03-replay.sh](evidence/2026-10-03-replay.sh), which creates a fresh `mktemp -d` directory on each run.

Journeys were chosen in areas earlier passes had not covered: suppressions and `--strict`, complexity and class-size metrics on modern syntax, and the everyday design/cleancode rules on idiomatic React/Node code.

## Baseline

- `npm test`: 328 tests pass, exit 0.
- `node dist/cli.js --version`: `messcript 0.1.15`.
- Self-scan `node dist/cli.js src text typescript --ignore-tests`: exit 0.

## Journeys

### 1. Waive an intentional finding and keep it auditable (explored)

Goal: suppress single findings and regions in source, then audit them with `--strict` across report formats. Grounded in `docs/usage.md` § Suppressions and `docs/reports.md`.

- Ordinary path: `disable-next-line` on a line comment and on a block comment; nested `disable`/`enable` regions. Nesting held as documented: an inner `enable` left the outer region active, and the second `enable` closed it. A directive inside a template literal was correctly ignored.
- Variations: `--strict` with text, json, sarif, github, gitlab, checkstyle, and `--reportfile` (file written; JSON `suppressed: true`; SARIF `suppressions: [{kind: "inSource"}]`; checkstyle `suppressed="true"`; github/gitlab `[suppressed]`).
- A file whose only findings are suppressed exits 0 normally and exits 2 under `--strict`. `test/cli.test.mjs` ("named disable-next-line suppressions are omitted unless strict") asserts this behaviour, so the candidate was **rejected**.
- While building fixtures, this journey turned up confirmed bug 1 (marker substrings).

### 2. Read complexity and size metrics for modern code (explored)

Goal: complexity and size findings for TS/JS constructs match the documented decision points. Grounded in `docs/rules.md` § codesize.

- Exercised optional chains, `&&`/`||`/`??`, logical assignment, `switch` fallthrough, `try/catch/finally`, accessors, constructors with parameter properties, class-field arrows, object methods, generators, `for await`, labelled loops, and 1,100 sequential `if`s.
- Exercised class-size rules with overloads, parameter properties, `#private` methods, abstract classes, and a `this` parameter.
- Counts matched the documented rules. Overload signatures were not double-counted. A `this` parameter was not counted. The constructor counts as a public method for `ExcessivePublicCount`, consistently.
- No bugs confirmed. See observations O2 and O3.

### 3. Gate a React/Node codebase with the recommended rulesets (explored)

Goal: `typescript` (and `typescript,opinionated`) produce findings only for real smells in idiomatic React/TSX and Node code. Grounded in `docs/rules.md` ("React components and hooks ... handled with ordinary JavaScript and TypeScript expectations") and [spec #1](https://github.com/quality-gates/messcript/issues/1) (idiom cases exclude React components and hooks).

- Exercised `CountInLoopExpression` (wrapped, optional, and element-access `.length`; initializer correctly excluded), `EmptyCatchBlock` (comment-only, `;`, nested `{}`), `IfStatementAssignment` (`if`/`while`/`do`/`for`, compound and logical assignment), `ExitExpression` (11 call shapes), `DevelopmentCodeFragment` debug calls, and the naming rules on React components and hooks.
- Variations: arrow vs function-declaration components; JSX, fragment, and `null` returns; Ink `useApp().exit`; calls through `globalThis`/`window` with a direct-call control.
- This journey produced confirmed bugs 2–5.

## Confirmed bugs

All five replay identically 3 of 3 runs via `sh evidence/2026-10-03-replay.sh` with `MX="node dist/cli.js"`.

### 1. DevelopmentCodeFragment matches comment markers as substrings — [#281](https://github.com/quality-gates/messcript/issues/281)

- **Impact**: the default `typescript` gate fails (priority 2) on comments such as "Mastodon" and "shackles".
- **Replay**: `// Post the update to Mastodon.` → `node dist/cli.js words.ts text typescript`.
- **Expected**: no `DevelopmentCodeFragment` finding for that comment. **Actual**: reported at line 1.
- **Evidence**: [evidence/2026-10-03-development-marker-substrings.md](evidence/2026-10-03-development-marker-substrings.md)

### 2. CamelCaseMethodName reports PascalCase React function components — [#282](https://github.com/quality-gates/messcript/issues/282)

- **Impact**: every `export function Header() { return <h1/>; }` fails the default `typescript` gate at priority 1.
- **Replay**: `Header.tsx` above → `node dist/cli.js Header.tsx text typescript`.
- **Expected**: exit 0. **Actual**: exit 2, `CamelCaseMethodName [priority 1] The method Header is not named in camelCase.`
- **Evidence**: [evidence/2026-10-03-react-component-naming.md](evidence/2026-10-03-react-component-naming.md)

### 3. ConstantNamingConventions reports React arrow components and hooks — [#283](https://github.com/quality-gates/messcript/issues/283)

- **Impact**: `export const Header = () => <h1/>` and `export const useToggle = () => ...` get "should be defined in uppercase" under the default gate.
- **Replay**: `arrow.tsx` → `node dist/cli.js arrow.tsx text typescript`.
- **Expected**: exit 0. **Actual**: exit 2 with two priority-4 findings.
- **Evidence**: [evidence/2026-10-03-react-component-naming.md](evidence/2026-10-03-react-component-naming.md)

### 4. ExitExpression reports a locally bound `exit` — [#284](https://github.com/quality-gates/messcript/issues/284)

- **Impact**: an Ink app's `const { exit } = useApp(); exit();` is reported as a process exit at priority 1 under `opinionated`/`design`.
- **Replay**: `quit.tsx` → `node dist/cli.js quit.tsx text typescript,opinionated`.
- **Expected**: exit 0. **Actual**: exit 2, `ExitExpression [priority 1]`.
- **Evidence**: [evidence/2026-10-03-exit-and-debug-call-receivers.md](evidence/2026-10-03-exit-and-debug-call-receivers.md)

### 5. ExitExpression and DevelopmentCodeFragment miss calls through `globalThis`/`window` — [#285](https://github.com/quality-gates/messcript/issues/285)

- **Impact**: `globalThis.process.exit()`, `window.console.log()`, and `globalThis.console.log()` pass the gate silently.
- **Replay**: `globals.ts` → `node dist/cli.js globals.ts text typescript,opinionated`; control `control.ts` without the global receiver.
- **Expected**: same findings as the control. **Actual**: exit 0, no findings (control exits 2 with both).
- **Evidence**: [evidence/2026-10-03-exit-and-debug-call-receivers.md](evidence/2026-10-03-exit-and-debug-call-receivers.md)

## Rejected and unresolved candidates

- **Rejected**: `--strict` turns a suppressed-only result into exit 2. A CLI test asserts it, and the docs say `--strict` "includes" the findings.
- **Rejected**: a constructor counts toward `ExcessivePublicCount`. It is applied consistently and matches PHPMD's class-interface-size convention.
- **Unresolved**: class `static {}` blocks are not measured by any callable metric. The docs scope those metrics to "callables", and a static block is not one, so whether to measure it is a product decision.
- **Unresolved**: `??` inside a parameter default (`function f(a = x ?? 1)`) is not counted toward cyclomatic complexity. PHPMD does not count defaults either.
- **Unresolved**: `TooManyMethods` counts `abstract` method declarations. `docs/rules.md` says abstract declarations "do not create executable metric findings". Whether class-shape counts are "executable metrics" is unclear.
- **Unresolved**: `IfStatementAssignment` does not report `(m = v) ? 1 : 2`. The docs say "`if` (and similar) conditions", which may or may not include a ternary.

## Usability observations

- **O1 (observation)**: `ConstantNamingConventions` reports every module-level `const` not in UPPER_CASE, including functions and objects. 54 of 78 `.ts` files under `src/` open with `// messcript-disable ConstantNamingConventions`, so the project's own code opts out wholesale. *Suggestion*: restrict the rule to bindings that are "semantically constant", as [spec #1](https://github.com/quality-gates/messcript/issues/1) requires, or move it to `opinionated`.
- **O2 (observation)**: very large NPath values print as `NPath complexity of Infinity`. Above 2^53 the reported numbers are also imprecise. *Suggestion*: cap and print `>= threshold` or use BigInt.
- **O3 (observation)**: an unknown ruleset name on the CLI (`... text DevelopmentCodeFragment`) fails with "Unknown ruleset". XML `ref` accepts single rule names, so a user may expect the same on the CLI. The working route is `<ruleset> --only <Rule>`.
- **O4 (observation)**: marker findings always say `(context: module)`, even for comments inside a function. Debug-call findings name the enclosing function.

## Limitations and unexplored areas

- Syntax-only analysis by design; no type checker.
- Tested on macOS and Node v26.7.0 only. The packaged native executable was not exercised.
- Not explored this pass: `CouplingBetweenObjects`, `LackOfCohesionOfMethods`, the HTML reporter, and `--suffixes`/`--exclude` discovery edge cases.

## Issues filed

- [#281 — DevelopmentCodeFragment matches comment markers as substrings (Mastodon, shackles)](https://github.com/quality-gates/messcript/issues/281)
- [#282 — CamelCaseMethodName reports PascalCase React function components under the recommended rulesets](https://github.com/quality-gates/messcript/issues/282)
- [#283 — ConstantNamingConventions reports React arrow components and hooks as constants](https://github.com/quality-gates/messcript/issues/283)
- [#284 — ExitExpression reports calls to a locally bound exit (Ink useApp().exit)](https://github.com/quality-gates/messcript/issues/284)
- [#285 — ExitExpression and DevelopmentCodeFragment miss calls through globalThis/window](https://github.com/quality-gates/messcript/issues/285)
