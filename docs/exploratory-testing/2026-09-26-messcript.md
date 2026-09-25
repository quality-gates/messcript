# Exploratory testing — messcript — 2026-09-26

## Scope

Full CLI exploratory pass for messcript 0.1.13, built from `7eee809` (`npm run build`), Node v26.7.0, macOS. Isolated fixtures under `/tmp/mx-exploratory-2026-09-26`.

## Baseline

- `npm test`: 297 tests pass, exit 0.
- `node dist/cli.js --version`: `messcript 0.1.13`.
- Clean self-scan: `node dist/cli.js src text typescript --ignore-tests`: exit 0.

## Journeys

### 1. Clean code, naming, and TypeScript 4.9+ constructs (explored)

Goal: verify clean-code and naming rules (`DuplicatedArrayKey`, `IfStatementAssignment`, `BooleanArgumentFlag`, `StaticAccess`, `ConstantNamingConventions`) against modern TypeScript features including `satisfies` expressions, no-substitution template literals, and destructured parameters.

Exercised:
- `IfStatementAssignment`: correctly catches assignments in `if`, `while`, `do-while`, and `switch` conditions; ignores variable declarations in `for` loop headers.
- `ConstantNamingConventions`: flags lowercase `const` module bindings; respects uppercase `CONSTANT_NAME` conventions.
- `BooleanArgumentFlag`: detects boolean parameter flags with type annotations (`flag: boolean`) and default initializers (`flag = false`, `flag = false as boolean`).
- `StaticAccess`: flags direct and asserted static access to external classes (`MyService.run()`, `(MyService as any).run()`).
- `DuplicatedArrayKey`: correctly detects duplicate keys with numeric coercion, BigInt literals, boolean keys, and unwrapped/asserted string keys.

This journey uncovered confirmed bug 2 (`DuplicatedArrayKey` fails to recognize duplicate keys asserting TypeScript `satisfies` operator).

### 2. Class cohesion, design metrics, and element-access patterns (explored)

Goal: verify design rules and metrics (`LackOfCohesionOfMethods`, `CouplingBetweenObjects`, `EmptyCatchBlock`, `DevelopmentCodeFragment`, `ExitExpression`, `GlobalVariable`) accurately measure class architecture and development leftovers without false positives.

Exercised:
- `CouplingBetweenObjects`: measures class dependencies across imports, qualified names, decorators, constructor parameter properties, and satisfies assertions.
- `DevelopmentCodeFragment`: flags `debugger;`, case-insensitive comment markers (`// TODO:`, `/* FIXME: */`), and debug calls (`console.log`, `(console as any).log`).
- `EmptyCatchBlock`: catches both standard `catch (e) {}` and optional catch binding `catch {}`.
- `ExitExpression`: detects process exit calls (`process.exit(1)`, `(process as any).exit(1)`).
- `LackOfCohesionOfMethods` (LCOM4): tested cohesive and disjoint classes, trivial accessor exclusions, and string-bracket receiver calls (`this["method"]()`).

This journey uncovered confirmed bug 1 (`LackOfCohesionOfMethods` ignores no-substitution template literals in element-access receivers).

### 3. Opt-in explicitness analysis and class state boundaries (explored)

Goal: verify the opt-in `explicitness` ruleset (`ImplicitInput` and `ImplicitOutput`) and the `include-this` option across method calls, property writes, closures, and wrapped receivers.

Exercised:
- Pure parameter flows: verified explicit arguments and return values produce no implicit findings.
- Global and host object access: `console`, `fetch`, `window`, and `globalThis` sinks correctly reported.
- Mutable outer and loop bindings: closure captures over mutated outer variables flagged as implicit inputs.
- Class state with `include-this=true`: unwrapped property reads and writes correctly tracked as `this.field` flows while ordinary method calls (`this.method()`) stay quiet.

This journey uncovered confirmed bug 3 (`ImplicitInput` and `ImplicitOutput` under `include-this` misclassify wrapped `this` receivers).

## Confirmed bugs

### 1. LackOfCohesionOfMethods ignores no-substitution template literals in element-access receivers

- **Impact**: In classes where methods invoke sibling methods using template literals (`this[`method`]()`) or access shared instance fields via `this[`shared`]`, LCOM4 ignores the template-literal element access. Connected methods are classified into separate components (e.g. LCOM4 = 2), triggering false positive `LackOfCohesionOfMethods` [priority 3] failures in CI. Conversely, disjoint classes using template literals are treated as having 0 field accesses and omitted from active components, causing false negatives.
- **Starting conditions**: Analysis of a class under `design` or `LackOfCohesionOfMethods`.
- **Replay**:
  ```ts
  class ConnectedService {
    fieldA = 1;
    fieldB = 2;
    methodA() { const x = this.fieldA; this[`methodB`](); return x; }
    methodB() { const y = this.fieldB; return y; }
  }
  ```
  Run: `node dist/cli.js service.ts text design`
- **Expected**: Exit code 0 (clean, LCOM4 = 1).
- **Actual**: Exit code 2, reporting `LackOfCohesionOfMethods` with value 2.
- **Repeats**: 3 of 3 runs. Control with `this["methodB"]()` exits 0. Shared field access `this[`shared`]` similarly reproduces the failure.
- **Evidence**: [evidence/2026-09-26-lcom4-template-literals.md](evidence/2026-09-26-lcom4-template-literals.md)
- **Status**: Filed as [#240](https://github.com/quality-gates/messcript/issues/240).

### 2. DuplicatedArrayKey fails to recognize duplicate keys asserting TypeScript satisfies operator

- **Impact**: In TypeScript codebases using the `satisfies` operator in computed object literal keys (e.g. `{ [("endpoint" satisfies string)]: url1, endpoint: url2 }` or `{ [(42 satisfies number)]: 1, 42: 2 }`), `DuplicatedArrayKey` fails to unwrap `SatisfiesExpression`. Statically duplicate keys pass silently without warning.
- **Starting conditions**: Analysis of an object literal under `cleancode` or `DuplicatedArrayKey`.
- **Replay**:
  ```ts
  export const config = {
    [("endpoint" satisfies string)]: "https://api.example.com/v1",
    endpoint: "https://api.example.com/v2",
  };
  ```
  Run: `node dist/cli.js config.ts text cleancode`
- **Expected**: Exit code 2, reporting `DuplicatedArrayKey [priority 2] Duplicated array key endpoint, first declared at line 2.`.
- **Actual**: Exit code 0, 0 findings.
- **Repeats**: 3 of 3 runs. Control with `[("endpoint" as string)]` or literal `endpoint` exits 2 with the finding.
- **Evidence**: [evidence/2026-09-26-duplicated-array-key-satisfies.md](evidence/2026-09-26-duplicated-array-key-satisfies.md)
- **Status**: Filed as [#241](https://github.com/quality-gates/messcript/issues/241).

### 3. ImplicitInput and ImplicitOutput under include-this misclassify wrapped this receivers

- **Impact**: Under `include-this=true`, `thisFlow` checks only `node.parent`. When `this` is wrapped in parentheses (`(this).helper()`), assertions (`this!.helper()`, `(this as any).helper()`), or type assertions (`(this satisfies Service).helper()`), method calls are falsely reported as implicit inputs reading class state (`reads this`), directly violating the documented guarantee that method calls are excluded. In addition, property writes to wrapped receivers (`(this).state = 1`) fail to extract the member name and report generic `writes this` instead of `writes this.state`.
- **Starting conditions**: Analysis under `explicitness` with `include-this=true`.
- **Replay**:
  ```ts
  class Worker {
    state = 0;
    helper() {}
    run() {
      this!.helper();
      (this).state = 1;
    }
  }
  ```
  Policy XML:
  ```xml
  <ruleset name="strict-explicitness">
    <rule ref="rulesets/explicitness.xml/ImplicitInput"><properties><property name="include-this" value="true" /></properties></rule>
    <rule ref="rulesets/explicitness.xml/ImplicitOutput"><properties><property name="include-this" value="true" /></properties></rule>
  </ruleset>
  ```
  Run: `node dist/cli.js worker.ts text policy.xml`
- **Expected**: Exactly 1 finding: `ImplicitOutput [priority 3] The method run() writes this.state, an implicit output.`.
- **Actual**: 2 findings: `ImplicitInput [priority 3] The method run() reads this, an implicit input.` on line 6 (`this!.helper()`), and `ImplicitOutput [priority 3] The method run() writes this, an implicit output.` on line 7 (`(this).state = 1`).
- **Repeats**: 3 of 3 runs across `this!...`, `(this)...`, `(this satisfies Worker)...`, and `(this as any)...`.
- **Evidence**: [evidence/2026-09-26-explicitness-wrapped-this.md](evidence/2026-09-26-explicitness-wrapped-this.md)
- **Status**: Filed as [#242](https://github.com/quality-gates/messcript/issues/242).

## Usability observations

- **O1: Consistent unwrapping of TS 4.9+ `satisfies` expressions across rules**: Exploration revealed a systemic pattern where newer rules (e.g. `CouplingBetweenObjects`, `ImplicitInput` nondeterministic calls, `analyzeUnused`) unwrap `SatisfiesExpression`, but older rule-local `unwrapExpression` helpers (`ExitExpression`, `DevelopmentCodeFragment`, `StaticAccess`, `BooleanArgumentFlag`, `CountInLoopExpression`, and `DuplicatedArrayKey`) omit `ts.isSatisfiesExpression(node)`. Unifying AST unwrapping through a shared helper in `src/ast/` would prevent this class of omission across current and future rules.

## Limitations and unexplored areas

- Analysis is syntax-only by design; no type checker or runtime execution was used.
- Tested on macOS and Node v26.7.0 only.
- Standalone Homebrew binary was not tested in this pass (tested source CLI via `node dist/cli.js`).

## Issues filed

- [#240 — LackOfCohesionOfMethods ignores no-substitution template literals in element-access receivers](https://github.com/quality-gates/messcript/issues/240)
- [#241 — DuplicatedArrayKey fails to recognize duplicate keys asserting TypeScript satisfies operator](https://github.com/quality-gates/messcript/issues/241)
- [#242 — ImplicitInput and ImplicitOutput under include-this misclassify wrapped this receivers](https://github.com/quality-gates/messcript/issues/242)
