# messcript

Catch maintainability problems in JavaScript and TypeScript before they calcify:
oversized functions and classes, tangled dependencies, dead private code, muddy
naming, and other mess that reviews keep rediscovering.

`messcript` is a local CLI. It reads source as text, never runs your project,
never loads your dependencies, and needs no project config. Node.js 20.11+.

## Quick start

```console
git clone https://github.com/quality-gates/messcript.git
cd messcript
npm ci && npm run build
node dist/cli.js src text typescript --ignore-tests
```

That scans `src` with the recommended low-noise policy and prints findings on
stdout. Exit `0` is clean, `2` means findings, `1` means the tool or a source
file failed.

Common next steps:

```console
node dist/cli.js src text typescript,opinionated --ignore-tests
node dist/cli.js src sarif typescript --ignore-tests --reportfile reports/messcript.sarif
node dist/cli.js src github typescript --ignore-tests
```

Full command syntax, options, and discovery: [docs/usage.md](docs/usage.md).
What each rule checks: [docs/rules.md](docs/rules.md).
Machine-readable report shapes: [docs/reports.md](docs/reports.md).

## Install

```console
git clone https://github.com/quality-gates/messcript.git
cd messcript
npm ci && npm run build
node dist/cli.js --version
```

The compiled binary is `dist/cli.js`. Its version comes from `package.json`;
`messcript --version` and structured reports use the same value.

## Tune the gate

Start with `typescript` (or `javascript` for plain JS). Add `opinionated` when
you want the stricter checks the recommended set leaves out. Point at a custom
XML ruleset when thresholds or membership need to live in the repo:

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

## Suppress one intentional exception

```ts
// messcript-disable-next-line LongVariable
const deliberately_long_variable_name_for_a_fixture = 1;
```

Region form: `messcript-disable` / `messcript-enable`. Names are case-insensitive.
`--strict` keeps suppressed findings visible in the report.

## Drop it into CI

```yaml
# GitHub Actions
- run: npm ci && npm run build
- run: node dist/cli.js src github typescript --ignore-tests
```

```yaml
# GitLab Code Quality
script: node dist/cli.js src gitlab typescript --reportfile gl-code-quality-report.json
artifacts:
  reports:
    codequality: gl-code-quality-report.json
```

This repository also self-checks after building. A finding fails the job with
exit code `2`.

## Maintainers

Command reference and report formats: [docs/usage.md](docs/usage.md).

Mutation measurement uses Stryker (`npm run mutation`). Pull-request CI mutates
only production files changed against `origin/main`
(`npm run mutation:pr -- --base origin/main`).
