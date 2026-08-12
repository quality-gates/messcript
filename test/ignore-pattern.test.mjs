import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Writable } from "node:stream";
import { after, before, test } from "node:test";
import { runCli } from "../dist/cli.js";
import { analyze } from "../dist/analyzer.js";
import { loadRulesets, RulesetError } from "../dist/rulesets.js";

let workspace;

function capture() {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  return { stream, read: () => output };
}

function run(args) {
  const stdout = capture();
  const stderr = capture();
  const status = runCli(args, { stdout: stdout.stream, stderr: stderr.stream });
  return { status, stdout: stdout.read(), stderr: stderr.read() };
}

/** CLI in a child process so a hang becomes a failed assertion, not a stuck suite. */
function runCliTimed(args, timeoutMs = 2000) {
  const started = performance.now();
  const result = spawnSync(process.execPath, ["dist/cli.js", ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    cwd: process.cwd(),
  });
  const elapsedMs = performance.now() - started;
  const timedOut = Boolean(result.error && result.error.code === "ETIMEDOUT") || result.signal === "SIGTERM";
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    elapsedMs,
    timedOut,
  };
}

before(() => {
  workspace = mkdtempSync(join(tmpdir(), "messcript-ignore-pattern-"));
});

after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function writeSource(name, source) {
  const path = join(workspace, name);
  writeFileSync(path, source);
  return path;
}

function writeRuleset(name, xml) {
  const path = join(workspace, name);
  writeFileSync(path, xml);
  return path;
}

test("nested-quantifier ignorepattern is rejected before analysis and does not hang", () => {
  const source = writeSource(
    "redos.ts",
    `export function ${"a".repeat(30)}b(flag: boolean): boolean { return flag; }\n`,
  );
  const ruleset = writeRuleset(
    "redos.xml",
    `<ruleset name="evil">
  <rule ref="BooleanArgumentFlag">
    <properties>
      <property name="ignorepattern" value="(a+)+$"/>
    </properties>
  </rule>
</ruleset>`,
  );

  const result = runCliTimed([source, "text", ruleset], 2000);

  assert.equal(result.timedOut, false, "CLI hung on nested-quantifier ignorepattern");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ignorepattern/i);
  assert.equal(result.stdout, "");
  assert.ok(result.elapsedMs < 2000, `expected fast rejection, took ${result.elapsedMs.toFixed(0)}ms`);
});

test("alternation ReDoS ignorepattern is rejected before analysis and does not hang", () => {
  const source = writeSource(
    "alt-redos.ts",
    `export function ${"a".repeat(30)}b(flag: boolean): boolean { return flag; }\n`,
  );
  const ruleset = writeRuleset(
    "alt-redos.xml",
    `<ruleset name="evil">
  <rule ref="StaticAccess">
    <properties>
      <property name="ignorepattern" value="(a|a)*$"/>
    </properties>
  </rule>
</ruleset>`,
  );

  const result = runCliTimed([source, "text", ruleset], 2000);

  assert.equal(result.timedOut, false, "CLI hung on alternation ignorepattern");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ignorepattern/i);
  assert.ok(result.elapsedMs < 2000, `expected fast rejection, took ${result.elapsedMs.toFixed(0)}ms`);
});

test("invalid ignorepattern is a ruleset error, not a silent partial analysis", () => {
  const source = writeSource(
    "invalid-pattern.ts",
    `const deliberately_long_variable_name_for_testing = 1;
export function run(flag: boolean): number {
  try {} catch (e) {}
  if (flag = true) return 1;
  return 0;
}
`,
  );
  const ruleset = writeRuleset(
    "invalid-pattern.xml",
    `<ruleset name="broken">
  <rule ref="LongVariable">
    <properties><property name="maximum" value="10"/></properties>
  </rule>
  <rule ref="BooleanArgumentFlag">
    <properties><property name="ignorepattern" value="["/></properties>
  </rule>
  <rule ref="EmptyCatchBlock"/>
</ruleset>`,
  );

  const result = run([source, "text", ruleset]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ignorepattern|regular expression/i);
  assert.equal(result.stdout, "");
});

test("valid ignorepattern still suppresses matching methods via the CLI", () => {
  const source = writeSource(
    "valid-pattern.ts",
    `export function skipFlag(flag: boolean): void {}
export function keepFlag(flag: boolean): void {}
`,
  );
  const ruleset = writeRuleset(
    "valid-pattern.xml",
    `<ruleset name="ok">
  <rule ref="BooleanArgumentFlag">
    <properties><property name="ignorepattern" value="^skip"/></properties>
  </rule>
</ruleset>`,
  );

  const result = run([source, "text", ruleset]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /keepFlag/);
  assert.doesNotMatch(result.stdout, /skipFlag/);
  assert.equal(result.stderr, "");
});

test("a single rule failure does not drop findings from other rules on the same file", () => {
  const source = writeSource(
    "isolated.ts",
    `const deliberately_long_variable_name_for_testing = 1;
export function run(flag: boolean): number {
  try {} catch (e) {}
  if (flag = true) return 1;
  return 0;
}
`,
  );

  const loaded = loadRulesets(["cleancode", "naming", "design"]);
  const selections = loaded.selections.map((selection) =>
    selection.name === "BooleanArgumentFlag"
      ? {
          ...selection,
          properties: { ...selection.properties, ignorepattern: "[" },
        }
      : selection,
  );

  const result = analyze([source], selections);
  const rules = new Set(result.findings.map((finding) => finding.ruleName));

  assert.ok(
    result.errors.some((error) => /BooleanArgumentFlag|ignorepattern|regular expression/i.test(error.message)),
    `expected rule error, got ${JSON.stringify(result.errors)}`,
  );
  assert.ok(rules.has("LongVariable"), `expected LongVariable, got ${[...rules]}`);
  assert.ok(rules.has("EmptyCatchBlock"), `expected EmptyCatchBlock, got ${[...rules]}`);
  assert.ok(rules.has("IfStatementAssignment"), `expected IfStatementAssignment, got ${[...rules]}`);
  assert.equal(rules.has("BooleanArgumentFlag"), false);
});

test("loadRulesets rejects unsafe ignorepattern with RulesetError", () => {
  const ruleset = writeRuleset(
    "load-reject.xml",
    `<ruleset name="evil">
  <rule ref="BooleanArgumentFlag">
    <properties><property name="ignorepattern" value="(a+)+$"/></properties>
  </rule>
</ruleset>`,
  );

  assert.throws(() => loadRulesets([ruleset]), (error) => {
    assert.ok(error instanceof RulesetError);
    assert.match(error.errors.join("\n"), /ignorepattern/i);
    return true;
  });
});
