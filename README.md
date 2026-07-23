# messcript

`messcript` is an installable JavaScript and TypeScript mess detector. It
parses source without executing it, building it, loading project dependencies,
or requiring a project configuration file.

## Install

```sh
npm install --save-dev messcript
npx messcript --help
```

The package executable is `messcript`; its version comes from `package.json`.
`messcript --version` and structured reports use the same version.

## Command

```text
messcript <paths> <format> <ruleset[,ruleset...]> [options]
```

Paths and rulesets may be comma-separated. Ruleset names and rule names are
case-insensitive. File paths are resolved case-insensitively when loading XML
rulesets, including nested references.

Examples:

```sh
npx messcript src text javascript
npx messcript src,packages/api text typescript --ignore-tests
npx messcript src json javascript --reportfile messcript.json
npx messcript src sarif typescript --minimum-priority 3
```

## Mutation testing

Run the reproducible production mutation suite with:

```sh
npm run mutation
```

Stryker mutates only `src/**/*.ts`, runs the existing Node test files, and writes
the machine-readable report to `coverage/mutation/mutation.json`. The command
also prints the covered mutation score (covered-MSI) and counts for killed,
survived, uncovered, and timed-out mutants. Generated mutation output is
ignored by Git.

### Options

| Option | Meaning |
| --- | --- |
| `--minimum-priority N` | Keep priorities 1 through `N` (1 is highest). |
| `--maximum-priority N` | Keep priorities `N` through 5. |
| `--only RULES` | Keep only named rules already loaded by the rulesets. |
| `--enable RULES` | Add named loaded rules; never imports an absent rule. |
| `--disable RULES` | Remove named loaded rules. |
| `--reportfile PATH`, `--report-file PATH` | Write the complete report to `PATH` instead of stdout. |
| `--suffixes LIST` | Replace default source suffixes. |
| `--exclude PATHS` | Exclude paths from discovery. |
| `--ignore-tests` | Exclude conventional test/spec files and directories. |
| `--strict` | Include source-suppressed findings and mark them suppressed. |
| `--color auto\|always\|never` | For text: color only on a TTY, always, or never. |
| `--verbose` | Print unknown-reference diagnostics. |
| `--ignore-errors-on-exit` | Return 0 despite processing errors. |
| `--ignore-violations-on-exit` | Return 0 despite findings. |
| `--help`, `-h` | Show usage. |
| `--version`, `-v` | Show package version. |

Priority must be an integer from 1 through 5. A requested `--only`, `--enable`,
or `--disable` rule must be present in the loaded rulesets; otherwise the run
is an operational error.

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | No selected findings, or an ignore flag explicitly changed the result. |
| `1` | Operational, discovery, ruleset, or processing error. |
| `2` | Selected findings exist. |

Ignore flags change only the process code, never report contents. Processing
errors take precedence over findings.

## Formats

Supported formats are `text`, `json`, `xml`, `checkstyle`, `sarif`, `html`,
`ansi`, `github`, and `gitlab`.

- `text` is deterministic human-readable output. `--color=always` adds ANSI
  styling; `auto` styles only when stdout is a TTY.
- `ansi` always styles finding names/messages, even when stdout is piped.
- `html` is an escaped HTML table containing findings and processing errors.
- `github` emits GitHub Actions `::warning` and `::error` commands with
  normalized paths, 1-based lines/columns, priorities, and rule names.
- `gitlab` emits GitLab Code Quality JSON with stable fingerprints, severity,
  locations, priorities, and processing-error entries.
- `json` contains `{ tool, findings, errors }`.
- `xml` contains `<messcript>`, `<tool>`, `<findings>`, and `<errors>`.
- `checkstyle` emits Checkstyle-compatible `<file>` and `<error>` elements.
- `sarif` emits SARIF 2.1.0 results, locations, rule metadata, and processing
  errors as execution notifications.

Every structured finding includes its path, 1-based source location, stable
`ruleName`, priority, message, context, and suppression state. Report files
replace the destination contents with the complete selected report; stdout stays
empty when `--reportfile` is used.

## Rulesets

Priority 1 is most urgent. The default priorities and properties below are the
public rule contract. Property names are case-insensitive in XML. Compatibility
aliases include `maximum` for most `minimum` thresholds, `maximum` for
`CyclomaticComplexity.reportLevel`, and `minimum` for
`LackOfCohesionOfMethods.maximum`.

### Component membership

| Ruleset | Rules |
| --- | --- |
| `codesize` | `CyclomaticComplexity`, `NPathComplexity`, `ExcessiveMethodLength`, `ExcessiveClassLength`, `ExcessiveParameterList`, `ExcessivePublicCount`, `TooManyFields`, `TooManyMethods`, `TooManyPublicMethods`, `ExcessiveClassComplexity` |
| `naming` | `ShortClassName`, `LongClassName`, `ShortVariable`, `LongVariable`, `ShortMethodName`, `ConstantNamingConventions`, `BooleanGetMethodName`, `ConstructorWithNameAsEnclosingClass` |
| `unusedcode` | `UnusedPrivateField`, `UnusedLocalVariable`, `UnusedPrivateMethod`, `UnusedFormalParameter` |
| `cleancode` | `BooleanArgumentFlag`, `ElseExpression`, `StaticAccess`, `IfStatementAssignment`, `DuplicatedArrayKey` |
| `design` | `ExitExpression`, `GotoStatement`, `CountInLoopExpression`, `DevelopmentCodeFragment`, `EmptyCatchBlock`, `CouplingBetweenObjects`, `GlobalVariable`, `LackOfCohesionOfMethods` |
| `controversial` | `CamelCaseClassName`, `CamelCaseMethodName`, `CamelCasePropertyName`, `CamelCaseParameterName`, `CamelCaseVariableName` |

`GotoStatement` is a stable, loadable identity but JavaScript and TypeScript
have no goto statement; it never fabricates a finding.

### Recommended policies

`javascript` and `typescript` include all component rules except these
idiom-conflicting checks:

`ShortVariable`, `UnusedFormalParameter`, `BooleanArgumentFlag`,
`ElseExpression`, `StaticAccess`, `CountInLoopExpression`, and `ExitExpression`.

Both policies set `LongVariable.maximum` to `35` instead of the component
default `20`. `typescript` additionally treats declarations, overloads,
accessibility modifiers, parameter properties, enums, namespaces, and type-only
syntax as TypeScript syntax rather than executable JavaScript. Interfaces,
ambient and abstract declarations, overload signatures, and type-only
relationships do not create executable metric findings. `typescript` is the
recommended policy for mixed JS/TS repositories.

`opinionated` contains exactly the excluded checks above. Combine it with a
recommended policy for a stricter run:

```sh
npx messcript src text javascript,opinionated
```

JavaScript/TypeScript idiomatic defaults include short callback/index/error/
generic names, React components and hooks, underscore-prefixed intentional
unused parameters, destructuring, private identifiers, computed names that
cannot be statically known, and normal module/import/type-only structure.

### Rule contract

The message column describes the stable message template; `{...}` values are
computed from the finding.

#### `codesize`

| Rule | Priority | Properties (default) | Message / scope |
| --- | ---: | --- | --- |
| `CyclomaticComplexity` | 3 | `reportLevel=10` | `The {context} has a Cyclomatic Complexity of {n}. The configured cyclomatic complexity threshold is {threshold}.` Functions, methods, constructors, accessors, arrows. |
| `NPathComplexity` | 3 | `minimum=200` | `The {context} has an NPath complexity of {n}. The configured NPath complexity threshold is {minimum}.` |
| `ExcessiveMethodLength` | 3 | `minimum=100`, `ignore-whitespace=false` | `The {context} has {n} lines of code. Current threshold is set to {minimum}. Avoid really long methods.` |
| `ExcessiveClassLength` | 3 | `minimum=1000`, `ignore-whitespace=false` | `The {context} has {n} lines of code. Current threshold is set to {minimum}. Avoid really long classes.` |
| `ExcessiveParameterList` | 3 | `minimum=10` | `The {context} has {n} parameters. Consider reducing the number of parameters to less than {minimum}.` Destructured parameters count once; `this` does not count. |
| `ExcessivePublicCount` | 3 | `minimum=45` | `The {context} has {n} public methods and attributes. Consider reducing the number of public items to less than {minimum}.` |
| `TooManyFields` | 3 | `maxfields=15` | `The {context} has {n} fields. Consider redesigning {class} to keep the number of fields under {maxfields}.` |
| `TooManyMethods` | 3 | `maxmethods=25`, `ignorepattern=(^(set\|get\|is\|has\|with))i` | `The {context} has {n} non-getter- and setter-methods. Consider refactoring {class} to keep number of methods under {maxmethods}.` |
| `TooManyPublicMethods` | 3 | `maxmethods=10`, same `ignorepattern` | `The {context} has {n} public methods. Consider refactoring {class} to keep number of public methods under {maxmethods}.` |
| `ExcessiveClassComplexity` | 3 | `maximum=50` | `The {context} has an overall complexity of {n} which is very high. The configured complexity threshold is {maximum}.` |

#### `naming`

| Rule | Priority | Properties (default) | Message / scope |
| --- | ---: | --- | --- |
| `ShortClassName` | 3 | `minimum=3`, `exceptions=` | `Avoid classes with short names like {name}. Configured minimum length is {minimum}.` |
| `LongClassName` | 3 | `maximum=40`, `subtract-prefixes=`, `subtract-suffixes=` | `Avoid excessively long class names like {name}. Keep class name length under {maximum}.` |
| `ShortVariable` | 3 | `minimum=3`, `exceptions=` | `Avoid variables with short names like {name}. Configured minimum length is {minimum}.` |
| `LongVariable` | 3 | `maximum=20`, `subtract-prefixes=`, `subtract-suffixes=` | `Avoid excessively long variable names like {name}. Keep variable name length under {maximum}.` |
| `ShortMethodName` | 3 | `minimum=3`, `exceptions=` | `Avoid using short method names like {name}(). The configured minimum method name length is {minimum}.` |
| `ConstantNamingConventions` | 4 | none | `Constant {name} should be defined in uppercase`. Applies to semantically constant bindings. |
| `BooleanGetMethodName` | 4 | `checkParameterizedMethods=false` | `The '{name}()' method which returns a boolean should be named 'is...()' or 'has...()'`. |
| `ConstructorWithNameAsEnclosingClass` | 3 | none | Reports a method named like its enclosing class. |

#### `unusedcode`

All four rules have priority 3 and use lexical, declaration-aware analysis:

| Rule | Properties | Message |
| --- | --- | --- |
| `UnusedPrivateField` | none | `Avoid unused private fields such as '{name}'.` |
| `UnusedLocalVariable` | `allow-unused-foreach-variables=false`, `exceptions=` | `Avoid unused local variables such as '{name}'.` |
| `UnusedPrivateMethod` | none | `Avoid unused private methods such as '{name}'.` |
| `UnusedFormalParameter` | none | `Avoid unused parameters such as '{name}'.` |

Closures, exports, imports, destructuring, catch bindings, private members,
parameter properties, overloads, and type-only references are handled without
claiming whole-program certainty. Underscore-prefixed intentionally unused
parameters are exempt.

#### `cleancode`

| Rule | Priority | Properties | Message |
| --- | ---: | --- | --- |
| `BooleanArgumentFlag` | 1 | `exceptions=`, `ignorepattern=` | `The method {class}::{method} has a boolean flag argument {name}, which is a certain sign of a Single Responsibility Principle violation.` |
| `ElseExpression` | 1 | none | `The method {name} uses an else expression. Else clauses are basically not necessary and you can simplify the code by not using them.` |
| `StaticAccess` | 1 | `exceptions=`, `ignorepattern=` | `Avoid using static access to class '{class}' in method '{method}'.` |
| `IfStatementAssignment` | 1 | none | `Avoid assigning values to variables in if clauses and the like (line '{line}', column '{column}').` |
| `DuplicatedArrayKey` | 2 | none | `Duplicated array key {key}, first declared at line {line}.` Applies to statically known object-literal keys. |

#### `design`

| Rule | Priority | Properties | Message / scope |
| --- | ---: | --- | --- |
| `ExitExpression` | 1 | none | `The {context} contains an exit expression.` |
| `GotoStatement` | 1 | none | Non-applicable; always quiet for JS/TS. |
| `CountInLoopExpression` | 2 | none | `Avoid using {count} in {loop} loops.` |
| `DevelopmentCodeFragment` | 2 | `unwanted-functions=`, `markers=TODO,FIXME,HACK` | Debug call: `The {context} calls the typical debug function {name}() which is mostly only used during development.` Debugger: `The {context} contains a debugger statement which is mostly only used during development.` |
| `EmptyCatchBlock` | 2 | none | `Avoid using empty catch blocks in {context}.` |
| `CouplingBetweenObjects` | 2 | `maximum=13` | `The {context} has a coupling between objects value of {n}. Consider to reduce the number of dependencies under {maximum}.` |
| `GlobalVariable` | 1 | `report-immutable=false` | `Avoid using static mutable state: {name}.` Mutation-aware module/script and static state. |
| `LackOfCohesionOfMethods` | 3 | `The {context} has a Lack of Cohesion Of Methods (LCOM4) value of {n}. Consider to split this class into {n} smaller classes.` |

#### `controversial`

All five rules have priority 1. `CamelCaseClassName` has no properties;
`CamelCaseMethodName` and `CamelCasePropertyName` have
`allow-underscore=false`, `allow-underscore-test=false`; and
`CamelCaseParameterName` and `CamelCaseVariableName` have
`allow-underscore=false`. They report `The {role} {name} is not named in
camelCase.` for class, method, property, parameter, and variable roles
respectively. They are conservative around
private, destructured, declaration-only, computed, React, hook, and generic
names.

## Custom XML rulesets

Rulesets use PHPMD-style XML. Whole rulesets, single rules, nested custom files,
exclusions, priorities, and properties can be composed. Later duplicate rules
override earlier explicit priority/property values; rules deduplicate by stable
rule name.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ruleset name="team-policy">
  <rule ref="rulesets/codesize.xml">
    <exclude name="NPathComplexity" />
    <priority>2</priority>
  </rule>
  <rule ref="rulesets/naming.xml/LongVariable">
    <priority>1</priority>
    <properties>
      <property name="maximum" value="30" />
    </properties>
  </rule>
  <ruleset ref="javascript" />
  <rule ref="./shared.xml" />
</ruleset>
```

`ref="codesize"`, `ref="rulesets/codesize.xml"`, and
`ref="rulesets/codesize.xml/CyclomaticComplexity"` are equivalent whole or
single-rule forms. Names, refs, exclusions, and XML file lookup are
case-insensitive. Unknown direct rules and unknown ruleset files are
operational errors. Unknown references are never substituted; they are quiet
unless `--verbose` is set, then appear as warnings.

Filters run after all composition:

```sh
npx messcript src text team-policy --only LongVariable --disable ShortVariable
npx messcript src json javascript --minimum-priority 2 --maximum-priority 3
npx messcript src text typescript --strict
npx messcript src text typescript --suffixes .ts,.tsx --exclude generated,dist
```

`--only`/`--enable` cannot import rules absent from the selected policy.

## Source suppressions

Directives are tool-specific and do not reinterpret ESLint directives. Rule
lists are comma- or whitespace-separated and names are case-insensitive.

```ts
// messcript-disable-next-line CyclomaticComplexity,NPathComplexity
function intentionally_complex() { /* ... */ }

// messcript-disable LongVariable
const deliberately_named_variable = value;
// messcript-enable LongVariable
```

`disable-next-line` applies only to the following physical line. `disable`
starts a nested region on the following line; `enable` closes only the named
rules, so unrelated findings remain active. Malformed directives are ignored
safely. Default reports omit suppressed findings. `--strict` includes the same
finding at the same location and marks it `[suppressed]` (or `suppressed: true`
in structured output).

To keep valid findings when one source file is malformed, run valid and
malformed paths together. Structured reports retain the finding and add a
processing-error record; the exit code is `1`:

```sh
npx messcript src/good.ts,src/broken.ts json typescript \
  --reportfile artifacts/report.json
```

## Discovery and errors

Default suffixes are `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`,
`.cts`, and `.d.ts`. Discovery is recursive, normalized, deterministic, and
deduplicates overlapping inputs. Dependencies, VCS data, generated output,
coverage, caches, build output, and common output directories are skipped.
Tests are included by default; `--ignore-tests` opts out.

Malformed source is isolated per file: valid files still produce findings and
the selected report contains processing-error records. A missing input path or
invalid command is an operational error before analysis.

## CI integration

Fail CI on either errors or findings by preserving the default exit behavior:

```sh
npm ci
npx messcript src text typescript --ignore-tests
```

For machine consumers, prefer SARIF in GitHub Actions, GitLab Code Quality JSON
with `gitlab`, or JSON/XML/Checkstyle for generic artifact storage:

```sh
mkdir -p artifacts
npx messcript src sarif typescript --reportfile artifacts/messcript.sarif
npx messcript src gitlab typescript --reportfile gl-code-quality-report.json
```

Repository self-analysis uses the same public executable after building:

```sh
npm run build
node dist/cli.js src text typescript --ignore-tests
```

Tests, fixtures, dependencies, generated files, coverage, caches, and build
outputs should be excluded from that gate. There is no required local Git hook.

## Development

```sh
npm ci
npm test
```

`npm test` builds the package, installs the packed artifact into an isolated
consumer, and runs the packaged acceptance suite plus metric tests.
