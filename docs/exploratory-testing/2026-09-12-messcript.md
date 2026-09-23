# Exploratory testing — messcript — 2026-09-12

## Scope

AFK CLI exploration of messcript 0.1.8 built from `34cfcdd` (`npm run build`),
Node v26.7.0, macOS. Fixtures were isolated under `/tmp/mx` and `~/mx-real`; the
pre-existing untracked worktree changes were left untouched. The only artefacts
kept in the repository are this report and its evidence files.

## Baseline

- `npm test` — all tests pass, exit 0.
- `npm run build` clean; `node dist/cli.js --version` → `messcript 0.1.8`.

## Journeys

### 1. Gate a mixed JS/TS project in CI (explored)

Goal: point messcript at a project, get findings, and have exit status drive CI.

Scanned a fixture with TypeScript and JavaScript sources, a `generated/` tree, a
test directory, and one deliberately unparseable file. Discovery, `--ignore-tests`,
`--exclude`, and path deduplication (`src,src,./src`) all behaved as documented.
The unparseable file produced a `ProcessingError` while the other files still
analysed, and errors took precedence over findings for exit status
(1 with the broken file, 2 without it). `--ignore-violations-on-exit` returned 0
with the report contents intact. Argument and configuration errors — unknown
format, unknown ruleset, missing arguments, out-of-range `--minimum-priority`,
unwritable `--reportfile` directory, nonexistent input path — each produced a
clear one-line message and exit 1.

Report formats `text`, `github`, `gitlab`, `checkstyle`, `json`, and `sarif` were
generated and inspected. Field shapes matched `docs/reports.md`. Path handling
differs between formats, which produced confirmed finding 3 below.

### 2. Tune the policy (explored)

Goal: adjust thresholds, membership, and exceptions without weakening the gate.

A custom XML ruleset referencing `typescript`, excluding a rule, and overriding
`ShortVariable` priority and `minimum` applied correctly, including adding a rule
the recommended set deliberately omits. `--only`, `--disable`, `--maximum-priority`,
and `--suffixes` all behaved as documented; `--only` on an unloaded rule failed
with exit 1 rather than silently importing it.

Source suppressions were exercised in both forms. `messcript-disable-next-line`,
region `messcript-disable` / `messcript-enable`, case-insensitive rule names, and
`--strict` re-showing suppressed rows marked `[suppressed]` all worked. Region
disables correctly stopped at the matching `enable`.

### 3. Trust the findings (explored)

Goal: findings match the rule catalogue, both at metric boundaries and on
ordinary language constructs.

Boundary probes across `CyclomaticComplexity`, `NPathComplexity`,
`ExcessiveParameterList`, `CouplingBetweenObjects`, `TooManyFields`, and
`ExcessiveMethodLength` found one threshold inconsistency (confirmed finding 1).
Construct probes covered `EmptyCatchBlock`, `CountInLoopExpression`,
`DevelopmentCodeFragment`, `DuplicatedArrayKey`, `GlobalVariable`,
`UnusedPrivateField`, `UnusedPrivateMethod`, and the `unusedcode` conservative
back-off under dynamic member access — all behaved as catalogued, including the
correct decision not to flag a private field reachable via `(this as any)[k]`.

TypeScript-specific handling was probed with interfaces, type aliases, ambient
declarations, abstract members, enums, namespaces, parameter properties, and
overloads. Metric rules correctly ignore overload signatures; naming rules do
not, which produced confirmed finding 2.

## Confirmed bugs

1. [#175 — CyclomaticComplexity never fires at its configured threshold](https://github.com/quality-gates/messcript/issues/175).
   A callable measured at exactly `reportLevel` is not reported, because
   `src/rules/cyclomatic-complexity.ts:32` uses `>` where every sibling codesize
   rule uses an inclusive comparison and `docs/rules.md` says "reaches". The gate
   is one point looser than configured. Reproduced twice.
   Evidence: [2026-09-12-cyclomatic-off-by-one.md](evidence/2026-09-12-cyclomatic-off-by-one.md).

2. [#176 — Naming rules report one finding per TypeScript overload signature](https://github.com/quality-gates/messcript/issues/176).
   One function name yields N identical findings and needs N suppression
   comments, while metric rules already skip signatures. Reproduced twice.
   Evidence: [2026-09-12-overload-duplicate-naming.md](evidence/2026-09-12-overload-duplicate-naming.md).

3. [#177 — SARIF output uses absolute filesystem paths](https://github.com/quality-gates/messcript/issues/177).
   `artifactLocation.uri` is the runner's absolute checkout path with no
   `uriBaseId`, so code scanning cannot map alerts to repository files and the
   report is not reproducible across machines. Reproduced from two working
   directories. Evidence: [2026-09-12-sarif-absolute-paths.md](evidence/2026-09-12-sarif-absolute-paths.md).

## Unresolved candidates

- `EmptyCatchBlock` does not flag `catch (err) { ; }` (a body containing only an
  empty statement), though it does flag a comment-only body. Whether an empty
  statement should count is a judgement call about the rule's intent, not a clear
  contract violation, so this was not filed.
- `NPathComplexity` returns 2 for `switch (a) { case 1: case 2: break; }` — two
  case labels sharing one fallthrough body and no `default`. PMD's formula would
  suggest 3. The correct treatment of fallthrough labels under a syntax-only
  metric is not specified anywhere in the docs, so this is left open.
- Enum members are exempt from `ConstantNamingConventions` and
  `CamelCasePropertyName`: `enum Color { green_thing = 2 }` produces no finding
  under `typescript,opinionated,controversial`. The docs say `typescript` treats
  enums as TypeScript rather than executable JavaScript, which plausibly covers
  this, but the exemption is not stated for naming rules specifically.

## Usability observations

These are observations from the journeys above, not defects.

- Error messages for bad arguments are short, specific, and actionable; the
  `--only` failure naming the rule that is not loaded is particularly good.
- `--strict` marking rows `[suppressed]` inline makes auditing waivers easy
  without a second run.
- Path representation varies by format within one run (relative in `text`,
  `github`, `gitlab`; absolute in `json`, `xml`, `checkstyle`, `sarif`).
  `docs/reports.md` documents this, but it is surprising when comparing two
  formats of the same scan side by side. Suggested improvement: state the
  absolute-path behaviour in the per-format sections too, not only in the
  preamble.
- `--ignore-errors-on-exit` returning 2 when findings also exist is correct per
  the documented precedence rules, but the flag name reads as "succeed anyway".
  Suggested improvement: a sentence in `docs/usage.md` showing that the two
  ignore flags must be combined to force exit 0.

## Limitations

- The CLI is the only user-facing surface; there is no UI or service to drive.
- Analysis is syntax-only by design; no type checker or dependency resolution was
  exercised, and findings were judged against `docs/rules.md` rather than against
  semantic correctness.
- Tested on macOS and Node v26.7.0 only. The Homebrew standalone executable was
  not exercised — only the source build.
- Mutation testing (`npm run mutation`) was not run; it was out of scope for an
  exploratory pass.
