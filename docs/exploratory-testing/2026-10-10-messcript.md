# Exploratory testing — messcript — 2026-10-10

## Scope

Full CLI pass on messcript 0.1.17, built from `origin/main` at `c951bf2` (`npm ci`, then `npm run build`). Node v26.7.0, macOS. Isolated fixtures lived under the fleet scratch `TMPDIR` and were removed afterwards. Replays use [evidence/2026-10-10-replay.sh](evidence/2026-10-10-replay.sh), which creates a fresh `mktemp -d` directory on each run.

Journeys were chosen around the scope-unification refactor and the areas the 2026-10-03 pass left open: report formats and discovery, unused code and explicitness, and class cohesion and coupling.

## Baseline

- `node dist/cli.js --version`: `messcript 0.1.17`.
- Self-scan `node dist/cli.js src text typescript --ignore-tests`: exit 0.
- `npm test` was not re-run. The build is `tsc --build` of the fetched default branch.

## Journeys

### 1. Scan a small app and read the report (explored)

Goal: a mixed JS/TS tree, scanned with `typescript,opinionated`, produces findings only for real smells, and the report formats, discovery flags, and suppressions match `docs/usage.md` and `docs/reports.md`.

- Ordinary path: directory scan found `ElseExpression`, `BooleanArgumentFlag`, and `ConstantNamingConventions`. `generated/` and `vendor/` were skipped. A symlink cycle did not hang. A parse error did not stop analysis of the next file. Exit 1 when a processing error was present, even if findings were also present. `--ignore-errors-on-exit` left findings at exit 2. Both ignore flags returned 0 and kept the report rows.
- Variations: `--ignore-tests` dropped `test/`. `--exclude` dropped `scripts/` and `lib/`. `--suffixes ts` and `--suffixes ts,tsx` replaced the suffix list. `--disable ElseExpression` removed that rule. A custom XML policy excluding `ConstantNamingConventions` left a clean file. A ruleset cycle failed with a circular-reference error. Unknown ruleset, unknown format, missing path, and `--only` of a rule the policy did not load failed with exit 1 and a one-line `Error:` on stderr.
- Suppressions: `messcript-disable-next-line` on the line before `else`, and a nested `disable`/`enable` region, hid the inner finding and left the outer one. `--strict` marked the hidden rows `[suppressed]` and did not hide the unsuppressed `else`.
- Reports: `html`, `sarif`, `gitlab`, `checkstyle`, and `xml` carried the same two findings as `text`. HTML escaped `>` in a parse-error message. GitHub percent-escaped a comma in a discovered filename (`comma%2Cname.ts`). SARIF and GitLab paths were workspace-relative. `--reportfile` replaced an existing file and wrote nothing to stdout. A missing parent directory failed with `ENOENT` and exit 1. Passing the same file twice did not double findings. `typescript,opinionated,opinionated` did not double findings.
- React regression check: `export function Header`, `export const Card = () => <section />`, and `export const useToggle` were not reported by `CamelCaseMethodName` or `ConstantNamingConventions`. A class method `Header()` returning JSX was reported. An object-literal method `Header()` was not, which led to confirmed bug 2.

### 2. Unused bindings and implicit flow after the scope refactor (explored)

Goal: unused locals, parameters, and private members match `docs/rules.md`, and `explicitness` reports the documented flows, including the element-access and wrapped-`this` cases fixed in #242 and #274.

- Used bindings stayed quiet: shorthand properties, `var` across blocks, hoisted function declarations, `catch` bindings that are read, loop indexes, `for await`, decorators, `export { local }`, and a `this` parameter.
- Unused bindings were reported: `let` / `const` / `var`, unused parameters (underscore-prefixed `_skipped` stayed quiet), unused `catch` bindings, unused `for-of` bindings, unused destructured names, the outer of a shadowed pair, `#private` fields and methods, and `private` fields. JSX attribute names did not count as uses (#271 still holds). `allow-unused-foreach-variables` suppressed the `for-of` finding.
- Explicitness: a mutated outer `let` was an input; a compound write was an input and an output; an unmutated `const` was quiet; `items.push` was an argument mutation; reassigning a parameter was not an output; `console.log` and `Date.now()` were reported; `globalThis` / `window` / `self` sinks were reported. A parameter that shadows a mutated outer binding was quiet. With `include-this=true`, isolated `this["count"]`, `(this).count`, `this!.count`, `as`, and `satisfies` reads and writes were `this.count`. `this["format"]()` and `(this).format()` were quiet. Constructor writes were quiet.
- A static block's unused local was reported.

### 3. Class cohesion, coupling, and naming (explored)

Goal: `LackOfCohesionOfMethods` and `CouplingBetweenObjects` follow `docs/rules.md`, and naming rules treat object-literal methods as methods.

- Cohesive classes were quiet: shared parameter-property field, `#private` fields used by one method, template-literal element access connecting methods (#240 still holds), getter/setter backing fields, and `this.helper()` calls. A static method and an instance method that do not share state were LCOM 2. Destructuring `const { left } = this` connected the methods.
- Coupling at `maximum=3`: 3 local type references fired, 2 did not. 3 `new` expressions fired. Builtins and `new` of the class itself did not. 3 import specifiers fired as a module finding, not a class finding. The default maximum of 13 stayed quiet on that small file.
- This journey produced confirmed bug 1. Comparing object-literal methods with class methods produced confirmed bug 2.

## Confirmed bugs

Both replay identically 3 of 3 runs via `sh evidence/2026-10-10-replay.sh` with `MX="node dist/cli.js"`.

### 1. LackOfCohesionOfMethods treats a bare identifier as a field use — [#303](https://github.com/quality-gates/messcript/issues/303)

- **Impact**: a class whose methods do not share instance state passes the cohesion gate when one method mentions a free name that matches a field.
- **Replay**: `bumpRight() { return left; }` next to `bumpLeft() { this.left += 1; }` → `node dist/cli.js bag.ts text design --only LackOfCohesionOfMethods`.
- **Expected**: exit 2, LCOM4 value of 2. **Actual**: exit 0. Control that writes `this.right` exits 2.
- **Evidence**: [evidence/2026-10-10-lcom-bare-identifier.md](evidence/2026-10-10-lcom-bare-identifier.md)

### 2. Naming rules miss object-literal methods — [#304](https://github.com/quality-gates/messcript/issues/304)

- **Impact**: `Bad_Name`, `ab`, and `getActive() { return true; }` in an object literal pass the default `typescript` naming gate. The same methods on a class fail it.
- **Replay**: `handlers.ts` → `node dist/cli.js handlers.ts text typescript`.
- **Expected**: `CamelCaseMethodName`, `ShortMethodName`, and `BooleanGetMethodName` on the object methods and the class methods. **Actual**: only the class methods.
- **Evidence**: [evidence/2026-10-10-object-literal-methods.md](evidence/2026-10-10-object-literal-methods.md)

## Rejected and unresolved candidates

- **Rejected**: `typeof` in a type position counts as a use, so a local referenced only by `typeof` is not an `UnusedLocalVariable`. The scope model treats type references as references, and the rule asks for a proven use.
- **Rejected**: a write-only local (`count = 1` with no read) is not unused. The assignment is a reference.
- **Rejected**: `using handle = ...` with no later read is an unused local. The rule asks for a proven use of the binding. The disposal is real, but nothing in the docs exempts `using`.
- **Unresolved**: a `const` inside a `namespace` is not an unused local, including a namespace nested in a function. Namespace scope is excluded from the local-variable walk. Whether that const is a local is not settled by the docs.
- **Unresolved**: `global.process.exit()` and `global.console.log()` are silent. `globalThis.process.exit()` and `globalThis.console.log()` are reported. `docs/rules.md` names `window`, `globalThis`, and `self`, not Node's `global`.
- **Unresolved**: SARIF `artifactLocation.uri` is not percent-encoded, so a path with a space (`j3/my files/note.ts`) is not a valid URI. The messcript docs do not say to encode it. GitHub workflow commands keep the space and escape commas, which matches `docs/reports.md`.
- **Unresolved**: class coupling counts same-file interfaces and `new` of same-file classes. The docs say "external" types. That may mean "other than this class" rather than "other than this file". Imported function calls are not added to the class count; the import declarations are counted on the module instead.
- **Unresolved**: a PascalCase class method that returns JSX is still a `CamelCaseMethodName` finding. Function declarations are exempt. The docs do not say class methods are components.

## Usability observations

- **O1 (observation)**: `ConstantNamingConventions` still reports every module-level `const` that is not `UPPER_CASE`, including function and component bindings. Same observation as the 2026-10-03 pass. Not refiled.
- **O2 (observation)**: processing-error messages embed the absolute filesystem path. Text, HTML, and GitHub locations are workspace-relative. The message is not. A missing `--reportfile` parent also prints a raw `ENOENT` rather than creating the directory. The README example `reports/messcript.sarif` fails if `reports/` does not exist.
- **O3 (observation)**: an explicit path with a comma cannot be passed, because commas separate paths. Discovery of a file that already contains a comma works. There is no escape. An explicit extensionless file is skipped with exit 0, including under `--verbose`.
- **O4 (observation)**: an unused destructured name is reported as `local variable { name, age }` in the context, while the message names `age`. The message is the clearer of the two.

## Limitations and unexplored areas

- Syntax-only analysis by design. No type checker.
- Tested on macOS and Node v26.7.0 only. The packaged native executable was not exercised.
- Not explored this pass: `ExcessiveClassLength` thresholds on real projects, Homebrew install, or HTML rendering in a browser.
- `npm test` was not part of this pass.

## Issues filed

- [#303 — LackOfCohesionOfMethods treats a bare identifier as a use of a same-named field](https://github.com/quality-gates/messcript/issues/303)
- [#304 — CamelCaseMethodName, ShortMethodName, and BooleanGetMethodName miss object-literal methods](https://github.com/quality-gates/messcript/issues/304)
