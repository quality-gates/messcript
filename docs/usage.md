# Using messcript

Point messcript at JavaScript or TypeScript source, pick a report format, pick a
policy, and read the findings. It never runs your code, never installs your
dependencies, and never needs a project config file.

```console
messcript <path[,path...]> <format> <ruleset[,ruleset...]> [options]
```

From a built checkout the binary is `node dist/cli.js`:

```console
node dist/cli.js src text typescript --ignore-tests
node dist/cli.js app,packages/api json typescript,opinionated --reportfile messcript.json
node dist/cli.js . github path/to/team-policy.xml --exclude generated --ignore-tests
```

Requires Node.js 20.11+. Syntax acceptance follows the TypeScript parser messcript
ships with: if a file cannot be parsed, messcript records a processing error for
that file and continues with the rest.

## Choose a format

| Format | Use it when |
|---|---|
| `text` | You are reading findings in a terminal. |
| `ansi` | Same as `text`, always with color. |
| `json` / `xml` | You are writing a custom consumer or storing a full machine report. |
| `html` | You want a simple browsable table. |
| `github` | GitHub Actions should annotate the relevant lines. |
| `gitlab` | GitLab Code Quality should show findings on the merge request. |
| `checkstyle` | An existing Checkstyle-compatible CI step will ingest the file. |
| `sarif` | You are uploading to code scanning or another SARIF consumer. |

Field-level shapes for every format are in [reports.md](reports.md).

## Choose a policy

| Ruleset | Intent |
|---|---|
| `typescript` | Recommended default for TS and mixed JS/TS repos. Low noise; understands TypeScript syntax. |
| `javascript` | Same recommended membership as `typescript`, for plain JavaScript. |
| `opinionated` | The stricter checks the recommended sets deliberately omit. Combine as `typescript,opinionated`. |
| `codesize` | Size and complexity only. |
| `naming` | Name length, constants, boolean getters. |
| `unusedcode` | Unused locals, parameters, and private members. |
| `cleancode` | Boolean flags, dead `else`, static access, assignment-in-condition, duplicate object keys. |
| `design` | Exits, empty handlers, coupling, globals, cohesion, development leftovers. |
| `controversial` | camelCase identifiers and PascalCase classes. |

Comma-separated values may mix built-ins and custom XML paths:

```console
node dist/cli.js src text typescript,path/to/extra.xml --ignore-tests
```

Membership, defaults, thresholds, and JS/TS-specific behavior for every rule are
in [rules.md](rules.md).

## Options

| Option | Meaning |
|---|---|
| `-h`, `--help` | Show command help. |
| `-v`, `--version` | Show the package version. |
| `--suffixes LIST` | Replace the default source suffix list. |
| `--exclude LIST` | Exclude matching normalized paths (generated trees, vendored code, one awkward package). |
| `--ignore-tests` | Skip conventional test directories and `*.test.*` / `*.spec.*` files. Use this for a production-code gate. |
| `--only LIST`, `--enable LIST` | Keep only named rules already present in the loaded policy. Useful for bisecting a noisy run. Cannot import a rule the policy did not load. |
| `--disable LIST` | Remove named loaded rules without writing new XML. |
| `--minimum-priority 1-5`, `--maximum-priority 1-5` | Inclusive priority filters. Start enforcement at priority 1–2, then widen. |
| `--reportfile PATH` | Replace a report file instead of writing stdout. `--report-file` is accepted. |
| `--color auto\|always\|never` | Control text color; `ansi` always uses color. |
| `--strict` | Include findings hidden by source suppressions so exceptions stay auditable. |
| `--verbose` | Write unknown-reference diagnostics to stderr when a ruleset is not loading as expected. |
| `--ignore-errors-on-exit` | Return success despite operational or processing errors. Report contents still include the errors. |
| `--ignore-violations-on-exit` | Return success despite findings. Useful while adopting; report contents stay complete. |

## Exit status

Wire these into CI the same way you would any other quality gate.

| Code | Meaning |
|---:|---|
| 0 | Clean, or every relevant failure was explicitly ignored. |
| 1 | Command, configuration, discovery, report-write, or source processing error. Errors take precedence over findings. |
| 2 | Selected findings and no non-ignored processing error. |

Ignore-on-exit flags change only the process status. They never remove rows from
the report.

## What gets scanned

- Paths are resolved, walked recursively, normalized, sorted, and deduplicated so
  repeated inputs do not double findings.
- Default suffixes are `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`,
  `.cts`, and `.d.ts`. `--suffixes` replaces that list for both explicit files
  and discovered files.
- Default skipped directory names include VCS directories, `node_modules`, tool
  caches, and common build, dist, coverage, generated, output, and temporary
  directories.
- Tests are included unless `--ignore-tests` is set, so excluding test quality
  is an explicit choice.
- A malformed or unreadable file becomes a `ProcessingError`. Other valid files
  still analyze.

## Custom XML policy

Keep team thresholds next to the code:

```xml
<ruleset name="team policy">
  <rule ref="typescript">
    <exclude name="DevelopmentCodeFragment" />
  </rule>
  <rule ref="LongVariable">
    <priority>2</priority>
    <properties>
      <property name="maximum" value="50" />
    </properties>
  </rule>
</ruleset>
```

```console
node dist/cli.js src text path/to/team-policy.xml --ignore-tests
```

References are case-insensitive and may name a built-in, one rule,
`rulesets/name.xml`, or another XML file relative to the current file. Rulesets
can nest; cycles and unknown direct rules or ruleset files fail. Later
references override earlier priority and property values.
`<exclude name="..."/>` removes a rule from the referenced set. Property names
are case-insensitive; common aliases such as `maximum` for a `minimum`
threshold are accepted.

## Suppressions in source

Waive one intentional finding without weakening the whole gate:

```ts
// messcript-disable-next-line LongVariable,CyclomaticComplexity
function deliberatelyDenseHelper() {
  // ...
}

// messcript-disable DevelopmentCodeFragment
// ... temporary debug region ...
// messcript-enable DevelopmentCodeFragment
```

Names are case-insensitive. Region disables nest and must be enabled
independently. Malformed directives are ignored and never reinterpret ESLint,
TypeScript, Prettier, or coverage comments. Normal reports omit suppressed
findings; `--strict` keeps them marked suppressed.
