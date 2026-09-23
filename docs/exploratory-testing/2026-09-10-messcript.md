# Exploratory testing — messcript — 2026-09-10

## Scope

AFK CLI exploration from commit `57eaf6b` (`messcript 0.1.6`) using an isolated fixture under `/tmp/messcript-exploratory-2026-09-10`. Node: `v26.7.0`.

The pre-existing worktree changes were left untouched.

## Baseline

`npm test`: 181 tests passed. Build and CLI smoke checks passed.

## Journeys

1. Full scan and reports: mixed TypeScript/JavaScript, ignored tests, generated directories, malformed input, clean JSON, SARIF, GitHub, and HTML output. Discovery, continued processing, report paths, and exit-code options behaved as documented.
2. Custom configuration: custom XML properties, strict and normal suppressions, `--only`, `--disable`, `--maximum-priority`, and ignored configuration errors. Behavior matched the documented controls.
3. Component policies: `design`, `cleancode`, `controversial`, `unusedcode`, `naming`, `typescript`, and `opinionated` against targeted fixtures. Findings matched expected rule coverage. Several old-branch misses corresponded to already-closed issues #140–#147 and were not duplicated.
4. Metric boundary variation: custom `NPathComplexity` threshold with empty and non-empty switches. This found one new confirmed defect.

## Confirmed bug

- [#157 — NPathComplexity reports zero for empty switch statements](https://github.com/quality-gates/messcript/issues/157). Reproduced twice with identical output. An empty switch returns NPath `0`; in a larger callable it also annihilates the enclosing path product, hiding later branches. Evidence: [2026-09-10-npath-empty-switch.md](evidence/2026-09-10-npath-empty-switch.md).

## Limitations

- Tested the local CLI only; no browser or long-running service exists in this project.
- Analysis is intentionally syntax-only; no type-checker or dependency loading was exercised.
- The local branch is 21 commits behind `origin/main`; testing remained pinned to the requested worktree commit.
