# Exploratory testing — messcript — 2026-09-23

## Scope

Full CLI exploratory pass for messcript 0.1.11, built from `957904c` (`npm run build`), Node v26.7.0, macOS. Isolated fixtures under `/tmp/mx-exploratory-2026-09-23`.

## Baseline

- `npm test`: 284 tests pass, exit 0.
- `node dist/cli.js --version`: `messcript 0.1.11`.
- Clean self-scan: `node dist/cli.js src text typescript --ignore-tests`: exit 0.

## Journeys

### 1. Modern JavaScript & TypeScript constructs under default and strict policies (explored)

Goal: verify clean-code, naming, and unused-code checks against modern JS/TS syntax without crashes or false positives.

Exercised:
- Private identifiers (`#field`, `#method`, `accessor #field`): `UnusedPrivateField` and `UnusedPrivateMethod` correctly flag unused private fields/methods and stay quiet when used via `this.#field`.
- Auto-accessors (`accessor x = 1`): correctly recognized as fields.
- Static initialization blocks (`static { ... }`): correctly scoped; `UnusedLocalVariable` caught unused bindings inside static blocks.
- TypeScript parameter properties (`private`, `protected`, `public`, `readonly`): unused private parameter properties are flagged; protected and public stay quiet.
- Destructured parameters and defaults: `UnusedFormalParameter` correctly flags unused elements inside object/tuple patterns while respecting underscore prefixes (`_param`).
- Object omission idiom (`const { password, ...user } = raw`): `UnusedLocalVariable` correctly flags `password` unless aliased or used.
- Control flow assignments: `IfStatementAssignment` correctly flags assignments in `while`, `for`, and `if` conditions.
- `DuplicatedArrayKey`: correctly detects duplicate keys with type coercion (`1` vs `'1'`, `[true]` vs `['true']`).

This journey uncovered confirmed bug 2 (`BooleanGetMethodName` misses private fields and wrapped `this`).

### 2. Complex control flow, cohesion, and metric boundaries (explored)

Goal: verify complexity and design metrics (`LackOfCohesionOfMethods`, `CouplingBetweenObjects`, `CyclomaticComplexity`, `NPathComplexity`) across modern language features and configured thresholds.

Exercised:
- Decision metrics on modern operators: optional chaining `?.`, nullish coalescing `??`, and logical assignments (`&&=`, `||=`, `??=`) correctly increment cyclomatic and NPath decision counts.
- `EmptyCatchBlock`: correctly catches both standard `catch (e) {}` and ES2019 optional catch binding `catch {}`.
- `DevelopmentCodeFragment`: correctly detects `debugger;` and case-insensitive comment markers (`// todo:`, `/* FIXME: */`).
- `StaticAccess`: correctly catches static class member calls via dot access, literal element access, and parenthesized expressions.
- `CouplingBetweenObjects`: measures class dependencies and module-level dependencies; respects configured XML maximum thresholds.
- `LackOfCohesionOfMethods` (LCOM4): tested disjoint and cohesive classes, trivial accessor exclusions, and receiver calls.

This journey uncovered confirmed bug 1 (`LackOfCohesionOfMethods` misses `this!` and `this satisfies T`).

### 3. Explicitness & state mutation tracking (explored)

Goal: verify the opt-in `explicitness` ruleset (`ImplicitInput`, `ImplicitOutput`, and `include-this`) alongside `v0.1.11`'s new loop binding mutation handling.

Exercised:
- Per-iteration loop bindings (`for (let i = 0; i < n; i++)`, `for (let x of items)`): verified closures capturing `x` do not produce false positive `ImplicitInput` findings when mutated only by the loop header.
- Outer loop bindings (`let x; for (x of items)`): correctly flagged as mutated and reported as `ImplicitInput` when captured in closures.
- Destructuring assignments (`({ a = 1 } = obj)`, `[ a, ...b ] = arr`): writes and mutations correctly tracked.
- All 9 output report formats (`text`, `ansi`, `json`, `xml`, `html`, `github`, `gitlab`, `checkstyle`, `sarif`): all formats produced valid syntax and consistent finding counts.
- Priority filters (`--minimum-priority`, `--maximum-priority`): numerical priority filtering (1 to 5) verified.

This journey uncovered confirmed bug 3 (`ImplicitOutput` misses element-access and parenthesized sinks).

## Confirmed bugs

### 1. LackOfCohesionOfMethods ignores non-null asserted and satisfies-asserted receivers

- **Impact**: In TypeScript codebases using `this!.method()` or `(this satisfies T).method()`, LCOM4 misses the receiver call edge between methods. Connected methods are falsely classified as separate components, resulting in false positive `LackOfCohesionOfMethods` [priority 3] failures in CI. Conversely, `this!.field` accesses are missed, omitting methods from the LCOM4 graph and causing false negatives on disjoint classes.
- **Starting conditions**: Analysis of a class under `design` or `LackOfCohesionOfMethods`.
- **Replay**:
  ```ts
  class ConnectedService {
    fieldA = 1;
    fieldB = 2;
    methodA() { const x = this.fieldA; this!.methodB(); return x; }
    methodB() { const y = this.fieldB; return y; }
  }
  ```
  Run: `node dist/cli.js test.ts text design`
- **Expected**: Exit code 0 (clean, LCOM4 = 1).
- **Actual**: Exit code 2, reporting `LackOfCohesionOfMethods` with value 2.
- **Repeats**: 3 of 3 runs. Control with `this.methodB()` exits 0.
- **Evidence**: [evidence/2026-09-23-lcom4-nonnull-satisfies.md](evidence/2026-09-23-lcom4-nonnull-satisfies.md)
- **Status**: Filed as [#215](https://github.com/quality-gates/messcript/issues/215).

### 2. BooleanGetMethodName fails to recognize boolean returns from private fields and wrapped this receivers

- **Impact**: Private fields (`#isValid = true`, `#isValid: boolean`) and wrapped receivers (`this!.isValid`, `(this).isValid`) in getter methods are not detected as returning boolean values. Methods like `getValid()` bypass `BooleanGetMethodName` without warning.
- **Starting conditions**: Analysis under `naming` or `BooleanGetMethodName`.
- **Replay**:
  ```ts
  class Validator {
    #isValid = true;
    getValid() { return this.#isValid; }
  }
  ```
  Run: `node dist/cli.js test.ts text naming`
- **Expected**: Exit code 2, reporting `BooleanGetMethodName [priority 4] The 'getValid()' method which returns a boolean should be named 'is...()' or 'has...()'`.
- **Actual**: Exit code 0, 0 findings.
- **Repeats**: 3 of 3 runs. Control with public `isValid = true` reports the finding.
- **Evidence**: [evidence/2026-09-23-boolean-get-private-identifier.md](evidence/2026-09-23-boolean-get-private-identifier.md)
- **Status**: Filed as [#216](https://github.com/quality-gates/messcript/issues/216).

### 3. ImplicitOutput misses sinks reached via element access and parenthesized globals

- **Impact**: Sinks invoked through element access (`window['alert']('msg')`, `globalThis['fetch']('/api')`, `window['console'].log(...)`) or parenthesized globals (`(window).alert()`) are not detected by `ImplicitOutput`. Furthermore, they are misreported as `ImplicitInput` ("reads window" / "reads globalThis"). In addition, nondeterministic calls via bracket access (`Date['now']()`, `Math['random']()`) or parenthesized receivers (`(Date).now()`) are missed by `ImplicitInput`.
- **Starting conditions**: Analysis under `explicitness`.
- **Replay**:
  ```js
  function f() { window['alert']('msg'); }
  ```
  Run: `node dist/cli.js test.js text explicitness`
- **Expected**: `ImplicitOutput [priority 3] The function f() uses alert, an implicit output.`
- **Actual**: `ImplicitInput [priority 3] The function f() reads window, an implicit input.`
- **Repeats**: 3 of 3 runs across `window[...]`, `globalThis[...]`, `(window)...`, and `(globalThis)...`. Control with `window.alert()` produces `ImplicitOutput`.
- **Evidence**: [evidence/2026-09-23-explicitness-bracket-sink.md](evidence/2026-09-23-explicitness-bracket-sink.md)
- **Status**: Filed as [#217](https://github.com/quality-gates/messcript/issues/217).

## Usability observations

- **O1: Priority filter documentation**: `--minimum-priority` and `--maximum-priority` operate numerically on the priority integer (1 to 5). Because priority 1 is highest and 5 is lowest, `--maximum-priority 2` selects high-priority rules (1 and 2), while `--minimum-priority 2` selects rules 2 through 5. The CLI help text ("Select findings at or above a priority") can be interpreted in either severity space or numerical space; clarifying this in `docs/usage.md` would prevent user confusion.

## Limitations and unexplored areas

- Analysis is syntax-only by design; no type checker or runtime execution was used.
- Tested on macOS and Node v26.7.0 only.
- Standalone Homebrew binary was not tested in this pass (tested source CLI via `node dist/cli.js`).

## Issues filed

- [#215 — LackOfCohesionOfMethods ignores non-null asserted and satisfies-asserted receivers](https://github.com/quality-gates/messcript/issues/215)
- [#216 — BooleanGetMethodName fails to recognize boolean returns from private fields and wrapped this receivers](https://github.com/quality-gates/messcript/issues/216)
- [#217 — ImplicitOutput misses sinks accessed via element access and parenthesized global objects](https://github.com/quality-gates/messcript/issues/217)
