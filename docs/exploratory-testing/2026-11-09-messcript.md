# Exploratory testing: messcript, 2026-11-09

## Scope and setup

This pass exercised the public CLI at `origin/main` commit `fb11fcd`, version 0.1.21, on Linux with Node 22.22.1 and npm 9.2.0. A separate worktree held the locked `npm ci` install, build, cache, fixtures, and reports. No services, browsers, or containers were started.

Expectations come from [usage](../usage.md) and [reports](../reports.md). The [replay script](evidence/2026-11-09-replay.sh) creates fresh fixtures, invokes the CLI, checks exit codes and report contents, and deletes its fixtures. Run it from the repository root after `npm ci` and `npm run build`. It requires Bash, `jq`, and Python 3. The script passed twice with fresh fixtures.

## Journeys

### Select source files for a gate

A developer needs one finding per source location, even with overlapping input paths. The project fixture contained an uppercase `.TS` source file, a test, and a generated file. Scanning both the project and the source file produced two findings, one from the source and one from the test, and exited 2. The generated file and duplicate input did not add findings. With `--ignore-tests`, only the source finding remained. Replacing the suffix list with `.js` produced no findings and exited 0.

### Send findings to CI and audit an exception

A developer needs structured reports that identify the same findings, including intentionally suppressed findings in audit mode. A fixture named `space #&.ts` had a suppressed long variable and an unsuppressed long variable. Strict JSON returned both with the correct suppression flags. SARIF written with `--reportfile` contained both results, encoded the filename as `space%20%23%26.ts`, and attached an in-source suppression only to the first. GitLab JSON and parsed XML also retained both suppression flags and the filename. Each command exited 2. A normal JSON scan omitted the suppressed finding and exited 2. The SARIF command left stdout empty and the saved file was parsed after the command returned.

### Recover from a cyclic team policy

A developer needs a configuration error to fail the gate rather than silently skip rules. Two XML policies referenced one another. The CLI exited 1 and reported a cycle on stderr. Replacing one reference with `LongVariable` let the same top-level policy run. The persisted JSON report contained the unsuppressed finding, no processing errors, and exit 2.

## Results and limitations

No confirmed bugs or unresolved product candidates arose, and no issues were filed. Existing issue titles, labels, comments, open PRs, worktrees, and releases were checked before the pass. Relevant prior reports include the fixed discovery cycle [#257](https://github.com/quality-gates/messcript/issues/257), uppercase suffix handling [#67](https://github.com/quality-gates/messcript/issues/67), cyclic policies [#123](https://github.com/quality-gates/messcript/issues/123), and SARIF URI encoding [#323](https://github.com/quality-gates/messcript/issues/323). Open explicitness work, including [#325](https://github.com/quality-gates/messcript/pull/325), was outside this pass.

The first `npm test` run had two failures because this pass placed `TMPDIR` inside the checkout. The affected tests expect temporary paths outside the current working directory. A retry used an outside-path symlink to the same worktree-local temporary directory. All 444 tests passed. `npm run check` and the recommended TypeScript dogfood command also passed. The temporary symlink was removed after the retry.

The pass did not test Homebrew, Windows, visual HTML rendering, every report format, or every rule family. The replay checks parsed report data rather than uploading reports to GitHub or GitLab. The policy cycle message identifies the configuration error, but this pass did not evaluate its wording as a usability finding.
