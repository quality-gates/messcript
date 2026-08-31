# Rules

Each finding names a stable rule id you can suppress, disable, or tune.
Priorities run from **1 (highest)** to **5 (lowest)**. Property values below
are catalogue defaults; finding messages state the comparison that fired.

Start with the built-in `typescript` policy (or `javascript` for plain JS). Both
keep useful checks and raise `LongVariable.maximum` from `20` to `35` so
descriptive names are not punished. Add `opinionated` when you want the stricter
set they leave out.

messcript only reads syntax. It does not run your code, load your packages, or
consult a type checker at analysis time. Short callback/index/error names, React
components and hooks, underscore-prefixed intentional unused parameters,
destructuring, private identifiers, computed names that cannot be known
statically, and ordinary module/import/type-only structure are handled with
ordinary JavaScript and TypeScript expectations. Names that cannot be known
statically are not guessed.

`typescript` additionally treats declarations, overloads, accessibility
modifiers, parameter properties, enums, namespaces, and type-only syntax as
TypeScript rather than executable JavaScript. Interfaces, ambient and abstract
declarations, overload signatures, and type-only relationships do not create
executable metric findings. Prefer `typescript` for mixed JS/TS repositories.

| Component | Rule | Priority | Default properties | What it catches |
|---|---|---:|---|---|
| `naming` | `ShortClassName` | 3 | `minimum=3`, `exceptions=` | Flags class names shorter than `minimum` so cryptic one- and two-letter types stand out. |
| `naming` | `LongClassName` | 3 | `maximum=40`, `subtract-prefixes=`, `subtract-suffixes=` | Flags class names longer than `maximum` so sprawling type names get shortened or split. |
| `naming` | `ShortVariable` | 3 | `minimum=3`, `exceptions=` | Flags parameter, property, and variable names shorter than `minimum`, with ordinary short-index exemptions. |
| `naming` | `LongVariable` | 3 | `maximum=20`, `subtract-prefixes=`, `subtract-suffixes=` | Flags parameter, property, and variable names longer than `maximum`. |
| `naming` | `ShortMethodName` | 3 | `minimum=3`, `exceptions=` | Flags function and method names shorter than `minimum`. |
| `naming` | `ConstantNamingConventions` | 4 | — | Flags bindings messcript can identify as constants that are not `UPPER_CASE`. |
| `naming` | `BooleanGetMethodName` | 4 | `checkParameterizedMethods=false` | Flags proven-boolean methods that still use a `get` prefix instead of `is` / `has`. |
| `naming` | `ConstructorWithNameAsEnclosingClass` | 3 | — | Flags a method named like its enclosing class (the old pre-`constructor` pattern). |
| `codesize` | `CyclomaticComplexity` | 3 | `reportLevel=10` | Flags callables whose decision count plus one reaches `reportLevel` (branches, loops, handlers, and similar). |
| `codesize` | `NPathComplexity` | 3 | `minimum=200` | Flags callables whose syntax-only independent path count is at least `minimum`. |
| `codesize` | `ExcessiveParameterList` | 3 | `minimum=10` | Flags callables with at least `minimum` parameters; a destructured parameter counts once, and `this` does not count. |
| `codesize` | `ExcessiveMethodLength` | 3 | `minimum=100`, `ignore-whitespace=false` | Flags callables with at least `minimum` physical lines. |
| `codesize` | `ExcessiveClassLength` | 3 | `minimum=1000`, `ignore-whitespace=false` | Flags classes with at least `minimum` lines; set `ignore-whitespace=true` to count nonblank lines only. |
| `codesize` | `ExcessivePublicCount` | 3 | `minimum=45` | Flags classes whose public methods plus attributes reach at least `minimum`. |
| `codesize` | `TooManyFields` | 3 | `maxfields=15` | Flags classes with more than `maxfields` fields. |
| `codesize` | `TooManyMethods` | 3 | `maxmethods=25`, `ignorepattern=(^(set\|get\|is\|has\|with))i` | Flags classes with more than `maxmethods` methods after `ignorepattern` exclusions (default skips common getter/setter-style names). |
| `codesize` | `TooManyPublicMethods` | 3 | `maxmethods=10`, same `ignorepattern` | Flags classes with more than `maxmethods` public methods after `ignorepattern`. |
| `codesize` | `ExcessiveClassComplexity` | 3 | `maximum=50` | Flags classes whose overall cyclomatic complexity is at least `maximum`. |
| `unusedcode` | `UnusedLocalVariable` | 3 | `allow-unused-foreach-variables=false`, `exceptions=` | Flags locals with no proven use inside their lexical scope. |
| `unusedcode` | `UnusedFormalParameter` | 3 | — | Flags parameters with no proven use; underscore-prefixed intentional unused names stay quiet. |
| `unusedcode` | `UnusedPrivateField` | 3 | — | Flags private fields with no proven class use, backing off when dynamic access makes certainty impossible. |
| `unusedcode` | `UnusedPrivateMethod` | 3 | — | Flags private methods with no proven class use, with the same conservative safeguards. |
| `cleancode` | `BooleanArgumentFlag` | 1 | `exceptions=`, `ignorepattern=` | Flags boolean parameters that often force forked call-site behavior; allowlist names with `exceptions` or `ignorepattern`. |
| `cleancode` | `ElseExpression` | 1 | — | Flags an `else` that is usually removable by early return or similar structure. |
| `cleancode` | `StaticAccess` | 1 | `exceptions=`, `ignorepattern=` | Flags static class access that is clearer as an ordinary function or instance method; allowlist with `exceptions` or `ignorepattern`. |
| `cleancode` | `IfStatementAssignment` | 1 | — | Flags assignments used directly in `if` (and similar) conditions. |
| `cleancode` | `DuplicatedArrayKey` | 2 | — | Flags repeated statically known keys in an object literal (the shared rule name still says Array). Dynamic keys are not guessed. |
| `design` | `ExitExpression` | 1 | — | Flags process-exit style calls such as `process.exit`. |
| `design` | `GotoStatement` | 1 | — | Does nothing on JavaScript/TypeScript—there is no goto statement. The id remains loadable so shared policies do not break; it never fires. |
| `design` | `CountInLoopExpression` | 2 | — | Flags length/count work repeated inside loop conditions. |
| `design` | `DevelopmentCodeFragment` | 2 | `unwanted-functions=`, `markers=TODO,FIXME,HACK` | Flags leftover debug calls (`debugger`, and names you add via `unwanted-functions`) and comment markers. Default markers: `TODO,FIXME,HACK` (case-insensitive). |
| `design` | `EmptyCatchBlock` | 2 | — | Flags `catch` handlers whose body does nothing. |
| `design` | `CouplingBetweenObjects` | 2 | `maximum=13` | Flags classes that touch at least `maximum` distinct external types/modules via syntax references. Counts references only—never loads the referenced modules. |
| `design` | `GlobalVariable` | 1 | `report-immutable=false` | Flags module/script and static state that is actually mutated. Set `report-immutable=true` to also report initialized immutable module state. Mutation-based by default so imports and true constants stay quiet. |
| `design` | `LackOfCohesionOfMethods` | 3 | `maximum=1` | Flags classes whose methods form more than `maximum` disconnected groups (LCOM4) via shared instance state and receiver calls. |
| `controversial` | `CamelCaseClassName` | 1 | — | Flags class names that are not PascalCase / UpperCamelCase. |
| `controversial` | `CamelCaseMethodName` | 1 | `allow-underscore=false`, `allow-underscore-test=false` | Flags method names that are not camelCase. Conservative around private, React, hook, and similar names. `allow-underscore` permits a single leading underscore everywhere; `allow-underscore-test` permits it independently, but only in test-context files (a conventional test directory such as `test/` or `__tests__/`, or a `*.test.*`/`*.spec.*` filename). |
| `controversial` | `CamelCasePropertyName` | 1 | `allow-underscore=false`, `allow-underscore-test=false` | Flags property names that are not camelCase, with the same conservative exemptions. `allow-underscore` and `allow-underscore-test` behave as for `CamelCaseMethodName`. |
| `controversial` | `CamelCaseParameterName` | 1 | `allow-underscore=false` | Flags parameter names that are not camelCase, after ordinary short-name exemptions. `allow-underscore` permits a single leading underscore. |
| `controversial` | `CamelCaseVariableName` | 1 | `allow-underscore=false` | Flags variable names that are not camelCase, after ordinary short-name and constant exemptions. `allow-underscore` permits a single leading underscore. |

## Built-in rulesets

Pass one or more of these as the third CLI argument. Comma-separate to compose.

- **`naming`** — Whether names are long enough, short enough, and conventionally shaped. `ShortClassName`, `LongClassName`, `ShortVariable`, `LongVariable`, `ShortMethodName`, `ConstantNamingConventions`, `BooleanGetMethodName`, `ConstructorWithNameAsEnclosingClass`
- **`unusedcode`** — Locals, parameters, and private members that appear never used. `UnusedPrivateField`, `UnusedLocalVariable`, `UnusedPrivateMethod`, `UnusedFormalParameter`
- **`cleancode`** — Small structural smells that make code harder to read and change. `BooleanArgumentFlag`, `ElseExpression`, `StaticAccess`, `IfStatementAssignment`, `DuplicatedArrayKey`
- **`design`** — Module and class design hazards: exits, empties, coupling, globals, cohesion. `ExitExpression`, `GotoStatement`, `CountInLoopExpression`, `DevelopmentCodeFragment`, `EmptyCatchBlock`, `CouplingBetweenObjects`, `GlobalVariable`, `LackOfCohesionOfMethods`
- **`codesize`** — How big and branchy callables and classes have become. `CyclomaticComplexity`, `NPathComplexity`, `ExcessiveMethodLength`, `ExcessiveClassLength`, `ExcessiveParameterList`, `ExcessivePublicCount`, `TooManyFields`, `TooManyMethods`, `TooManyPublicMethods`, `ExcessiveClassComplexity`
- **`controversial`** — Strict PascalCase classes and camelCase identifiers. `CamelCaseClassName`, `CamelCaseMethodName`, `CamelCasePropertyName`, `CamelCaseParameterName`, `CamelCaseVariableName`
- **`javascript`** / **`typescript`** — Recommended low-noise defaults. Same membership: all component rules except the `opinionated` set below, with `LongVariable.maximum=35`. `typescript` adds TypeScript-aware treatment of declarations, overloads, accessibility, parameter properties, enums, namespaces, and type-only syntax.
- **`opinionated`** — Stricter checks left out of the recommended sets; combine as `typescript,opinionated`. `ShortVariable`, `UnusedFormalParameter`, `BooleanArgumentFlag`, `ElseExpression`, `StaticAccess`, `CountInLoopExpression`, `ExitExpression`
