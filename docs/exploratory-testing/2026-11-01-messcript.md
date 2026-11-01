# Exploratory testing: messcript, 2026-11-01

## Scope and setup

This pass exercised the CLI in a worktree at `origin/main` commit `c34600b`, version 0.1.19, on Linux with Node 22.22.1 and npm 9.2.0. `npm ci` used a cache inside the worktree, and `npm run build` produced `dist/cli.js`. Fixtures and generated reports stayed inside the worktree. No services, browsers, or containers were started.

The expectations below come from [usage](../usage.md), [rules](../rules.md), and [reports](../reports.md). The [replay script](evidence/2026-11-01-replay.sh) builds fresh fixtures, calls the public CLI, checks the resulting reports and exit codes, and deletes its fixtures. Run it from the repository root after `npm ci` and `npm run build`. It requires Bash and `jq`.

## Journeys

### Scan a project and recover from a parse error

A developer needs a CI gate that scans source without losing findings when another file fails to parse. A project fixture contained a long variable in production, another in a test, a generated file, and a malformed TypeScript file. The JSON report included both source findings and one processing error, omitted the generated file, and exited 1. `--ignore-tests` removed the test finding. `--ignore-errors-on-exit` retained the error in the report but exited 2 for the remaining finding. After correcting the malformed file, the report retained the production finding and exited 2 without an error. A separate clean fixture exited 0.

### Suppress an exception and audit it

A developer needs to hide intentional findings without weakening the whole rule. A next-line directive hid one `LongVariable` finding while another remained visible. With `--strict`, both appeared and the hidden finding had `suppressed: true`. A second fixture nested two disabled regions. The ordinary report contained only the finding after both enables. The strict report contained all four findings, with the first three marked suppressed. Both reports exited 2 because the fourth finding was not suppressed.

### Tune a policy and persist a report

A developer needs a team threshold and a report for CI. A custom XML policy set `LongVariable` maximum to 10 and priority to 2. The JSON report found `ordinaryName` at line 1 with priority 2 and exited 2. A nested policy that excluded the rule exited 0 with no findings. The SARIF `--reportfile` command replaced an existing file, left stdout empty, and stored the finding. A subsequent clean scan replaced that report with an empty results array and exited 0.

## Results and limitations

No confirmed bugs or unresolved candidates arose from these journeys. No issues were filed. Existing open and closed issue titles were checked, including earlier discovery and suppression reports [#257](https://github.com/quality-gates/messcript/issues/257) and [#84](https://github.com/quality-gates/messcript/issues/84). The nested suppression and custom-policy replay passed twice from fresh fixtures. `npm test` passed all 441 tests. The replay script records the exact inputs and observable assertions.

A processing error message included an absolute path even though human-readable report locations are relative when possible. The message text is not specified as relative in the report contract, so this is a usability observation, not a confirmed bug.

The pass did not test the Homebrew executable, other operating systems, visual HTML rendering, all rule families, or all report formats. The lockfile install reported six moderate dependency vulnerabilities. Their applicability was not investigated, and no dependency changes were made.
